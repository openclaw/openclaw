import { isDeepStrictEqual } from "node:util";
import type { SessionInitialization } from "../../../sessions/session-initialization.js";
import {
  deleteSessionUpstreamLink,
  upsertSessionUpstreamLink,
  type SessionUpstreamLink,
} from "../../../sessions/session-upstream-links.js";

/** Backend binding ownership redeems the existing host initializer's exact creation handle. */
export function createNativeSessionInitializationOwner<TStore, TIdentity, TBinding>(options: {
  validateBinding: (binding: TBinding) => TBinding;
  writeBinding: (
    store: TStore,
    identity: TIdentity,
    binding: TBinding,
    assertCurrent: () => void,
  ) => Promise<boolean>;
  errors: {
    linkChanged: string;
    bindingChanged: string;
    linkWriteFailed: string;
    ownerChanged: string;
  };
}) {
  type Ownership = {
    store: TStore;
    identity: TIdentity;
    binding?: TBinding;
    assertCleanupAllowed?: () => void;
    cleanup: () => Promise<void>;
  };
  const initializations = new WeakMap<SessionInitialization, Ownership>();

  return {
    /** Capture cleanup ownership before any potentially committing binding or link write. */
    prepare(
      this: void,
      params: {
        initialization: SessionInitialization;
        bindingStore: TStore;
        identity: TIdentity;
        prepareCleanup?: () => (assertCurrent: () => void) => Promise<void>;
        assertCleanupAllowed?: () => void;
      },
    ) {
      const { initialization, bindingStore, identity } = params;
      initialization.assertCurrent();
      let link: SessionUpstreamLink | undefined;
      const ownership: Ownership = {
        store: bindingStore,
        identity: structuredClone(identity),
        assertCleanupAllowed: params.assertCleanupAllowed,
        cleanup: async () => {
          initialization.assertRollbackCurrent();
          if (
            link &&
            deleteSessionUpstreamLink(link.sessionKey, link.agentId, {
              expected: link,
              assertCommitAllowed: initialization.assertRollbackCurrent,
            }) === "changed"
          ) {
            throw new Error(options.errors.linkChanged);
          }
          initialization.assertRollbackCurrent();
          await cleanup?.(initialization.assertRollbackCurrent);
          initialization.assertRollbackCurrent();
        },
      };
      initializations.set(initialization, ownership);
      const cleanup = params.prepareCleanup?.();
      return {
        assertCurrent: initialization.assertCurrent,
        async bind(binding: TBinding) {
          initialization.assertCurrent();
          ownership.binding = options.validateBinding(binding);
          const stored = await options.writeBinding(
            bindingStore,
            identity,
            ownership.binding,
            initialization.assertCurrent,
          );
          if (!stored) {
            ownership.binding = undefined;
            throw new Error(options.errors.bindingChanged);
          }
          initialization.assertCurrent();
        },
        link(input: Parameters<typeof upsertSessionUpstreamLink>[0]) {
          initialization.assertCurrent();
          const now = Date.now();
          link = structuredClone({ ...input, createdAt: now, updatedAt: now });
          if (
            !upsertSessionUpstreamLink(input, {
              now,
              ifAbsent: true,
              assertCommitAllowed: initialization.assertCurrent,
            })
          ) {
            link = undefined;
            throw new Error(options.errors.linkWriteFailed);
          }
          initialization.assertCurrent();
        },
      };
    },

    getRollback(
      this: void,
      store: TStore,
      params: { initialization?: SessionInitialization },
      identity: TIdentity,
      binding: TBinding | undefined,
    ): (() => Promise<void>) | undefined {
      const handle = params.initialization;
      if (!handle) {
        return undefined;
      }
      handle.assertRollbackCurrent();
      const ownership = initializations.get(handle);
      if (!ownership && !binding) {
        return undefined;
      }
      if (
        !ownership ||
        ownership.store !== store ||
        !isDeepStrictEqual(ownership.identity, identity) ||
        (binding && !isDeepStrictEqual(ownership.binding, binding))
      ) {
        throw new Error(options.errors.ownerChanged);
      }
      // Reject indeterminate native work before either local deletion commits.
      ownership.assertCleanupAllowed?.();
      return ownership.cleanup;
    },
  };
}
