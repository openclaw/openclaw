import { isDeepStrictEqual } from "node:util";
import {
  getSessionInitializationUpstreamLinkCurrent,
  type SessionInitialization,
} from "../../../sessions/session-initialization.js";
import {
  deleteSessionUpstreamLinkAsync,
  upsertSessionUpstreamLink,
  upsertSessionUpstreamLinkAsync,
  upsertSessionUpstreamLinkWithCurrentSource,
  type SessionUpstreamLink,
} from "../../../sessions/session-upstream-links.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";

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
      const sourceCurrent = getSessionInitializationUpstreamLinkCurrent(initialization);
      const context = sourceCurrent?.context ?? captureOpenClawStateWorkerContext();
      const database = { path: context.admission.databasePath, env: context.environment };
      const assertCurrent = () => {
        context.admission.assertCurrent();
        initialization.assertCurrent();
      };
      const assertRollbackCurrent = () => {
        context.admission.assertCurrent();
        initialization.assertRollbackCurrent();
      };
      let link: SessionUpstreamLink | undefined;
      const ownership: Ownership = {
        store: bindingStore,
        identity: structuredClone(identity),
        assertCleanupAllowed: params.assertCleanupAllowed,
        cleanup: async () => {
          initialization.assertRollbackCurrent();
          if (
            link &&
            (await deleteSessionUpstreamLinkAsync(link.sessionKey, link.agentId, {
              ...database,
              expected: link,
              assertCommitAllowed: assertRollbackCurrent,
            })) === "changed"
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
        /** @deprecated Use linkAsync. Retained for released official harnesses until the next Plugin SDK major. */
        link(input: Parameters<typeof upsertSessionUpstreamLink>[0]) {
          initialization.assertCurrent();
          const now = Date.now();
          link = structuredClone({ ...input, createdAt: now, updatedAt: now });
          if (
            !upsertSessionUpstreamLink(input, {
              ...database,
              now,
              ifAbsent: true,
              assertCommitAllowed: assertCurrent,
            })
          ) {
            link = undefined;
            throw new Error(options.errors.linkWriteFailed);
          }
          initialization.assertCurrent();
        },
        async linkAsync(input: Parameters<typeof upsertSessionUpstreamLinkAsync>[0]) {
          assertCurrent();
          const now = Date.now();
          link = structuredClone({ ...input, createdAt: now, updatedAt: now });
          if (
            !(await upsertSessionUpstreamLinkWithCurrentSource(
              input,
              {
                ...database,
                now,
                ifAbsent: true,
                assertCommitAllowed: assertCurrent,
              },
              sourceCurrent,
            ))
          ) {
            link = undefined;
            throw new Error(options.errors.linkWriteFailed);
          }
          assertCurrent();
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
