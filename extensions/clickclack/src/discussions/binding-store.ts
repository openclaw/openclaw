import { isDeepStrictEqual } from "node:util";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateComparisonCondition,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export type ClickClackDiscussionBinding = {
  accountId: string;
  agentId: string;
  /** Concrete session incarnation; session keys can be reused after reset. */
  sessionId: string;
  serverBaseUrl: string;
  /** Non-secret digest used only to determine whether old-channel credentials remain available. */
  credentialFingerprint?: string;
  externalRef: string;
  externalUrl: string;
  /** Configured workspace selector at bind time; workspaceId is its canonical resolution. */
  workspaceRef: string;
  workspaceId: string;
  channelId: string;
  channelRouteId: string;
  workspaceRouteId: string;
  section: string;
  archived: boolean;
  label: string;
  displayTitle?: string;
  /** Set only while the owning OpenClaw session entry is absent. */
  detachedAt?: number;
};

export function bindingMatchesActiveSessionIncarnation(
  runtime: PluginRuntime,
  sessionKey: string,
  binding: ClickClackDiscussionBinding,
): boolean {
  const entry = runtime.agent.session.getSessionEntry({
    sessionKey,
    readConsistency: "latest",
  });
  return Boolean(
    entry &&
    binding.sessionId &&
    entry.sessionId === binding.sessionId &&
    entry.archivedAt === undefined,
  );
}

export async function readDiscussionSessionEntry(runtime: PluginRuntime, sessionKey: string) {
  const params = { sessionKey, readConsistency: "latest" } as const;
  return await runtime.agent.session.getSessionEntryAsync(params);
}

/**
 * Refresh the replaceable session attachment without changing the durable room identity.
 * The store registers persisted state before reindexing, so a failed write leaves the
 * previous attachment authoritative in both persistence and memory.
 */
export async function attachBindingToCurrentActiveSession(params: {
  runtime: PluginRuntime;
  store: ClickClackDiscussionBindingStore;
  sessionKey: string;
  binding: ClickClackDiscussionBinding;
}): Promise<ClickClackDiscussionBinding | undefined> {
  const entry = await readDiscussionSessionEntry(params.runtime, params.sessionKey);
  if (!entry?.sessionId || entry.archivedAt !== undefined) {
    return undefined;
  }
  if (entry.sessionId === params.binding.sessionId && params.binding.detachedAt === undefined) {
    return params.binding;
  }
  const { detachedAt: _detachedAt, ...retained } = params.binding;
  const attached = { ...retained, sessionId: entry.sessionId };
  const applied = await params.store.setIfCurrent(params.sessionKey, params.binding, attached, {
    assertCurrent: () => {
      const current = params.store.get(params.sessionKey);
      if (
        !current ||
        current.externalRef !== params.binding.externalRef ||
        current.serverBaseUrl !== params.binding.serverBaseUrl ||
        current.channelId !== params.binding.channelId ||
        !bindingMatchesActiveSessionIncarnation(params.runtime, params.sessionKey, attached)
      ) {
        throw new Error("ClickClack discussion session changed before attachment committed");
      }
    },
  });
  return applied ? attached : undefined;
}

const DISCUSSION_BINDINGS_NAMESPACE = "discussion-bindings";
const MAX_DISCUSSION_BINDINGS = 10_000;
const BINDING_STORE_OPTIONS = {
  namespace: DISCUSSION_BINDINGS_NAMESPACE,
  maxEntries: MAX_DISCUSSION_BINDINGS,
  overflowPolicy: "reject-new",
} as const;
export const MAX_RETAINED_DETACHED_DISCUSSION_BINDINGS = 1_000;
const storesByRuntime = new WeakMap<PluginRuntime, ClickClackDiscussionBindingStore>();

function channelKey(serverBaseUrl: string, channelId: string): string {
  return `${serverBaseUrl.replace(/\/+$/u, "")}\0${channelId}`;
}

/** SQLite-backed session/channel bindings with a process-local inbound lookup index. */
export class ClickClackDiscussionBindingStore {
  #nativeStore: PluginStateSyncKeyedStore<ClickClackDiscussionBinding> | undefined;
  #store: PluginStateKeyedStore<ClickClackDiscussionBinding, 2> | undefined;
  readonly #sessionByChannel = new Map<string, string>();
  readonly #detachedAtBySession = new Map<string, number>();
  readonly #channelBySession = new Map<string, string>();
  readonly #runtime: PluginRuntime;
  readonly #withMutation = createAsyncLock();
  #prepared = false;
  #preparing:
    | Promise<Array<{ sessionKey: string; binding: ClickClackDiscussionBinding }>>
    | undefined;
  readonly #changedDuringPreparation = new Set<string>();

  constructor(runtime: PluginRuntime) {
    this.#runtime = runtime;
  }

  async prepare(): Promise<void> {
    if (!this.#prepared) {
      await this.entries();
    }
  }

  async getAsync(sessionKey: string): Promise<ClickClackDiscussionBinding | undefined> {
    return await this.#workerStore().lookup(sessionKey);
  }

  get(sessionKey: string): ClickClackDiscussionBinding | undefined {
    // Final tool/disclosure authority stays native until synchronous SDK writers retire.
    this.#nativeStore ??=
      this.#runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>(BINDING_STORE_OPTIONS);
    return this.#nativeStore.lookup(sessionKey);
  }

  async hasCapacity(sessionKey: string): Promise<boolean> {
    return (
      (await this.getAsync(sessionKey)) !== undefined ||
      (await this.countAsync()) < MAX_DISCUSSION_BINDINGS
    );
  }

  async getByChannel(
    serverBaseUrl: string,
    channelId: string,
  ): Promise<{ sessionKey: string; binding: ClickClackDiscussionBinding } | undefined> {
    const key = channelKey(serverBaseUrl, channelId);
    const sessionKey = this.#sessionByChannel.get(key);
    if (!sessionKey) {
      return undefined;
    }
    const binding = await this.getAsync(sessionKey);
    if (!binding || channelKey(binding.serverBaseUrl, binding.channelId) !== key) {
      if (this.#sessionByChannel.get(key) === sessionKey) {
        this.#sessionByChannel.delete(key);
      }
      return undefined;
    }
    return { sessionKey, binding };
  }

  async setIfCurrent(
    sessionKey: string,
    expected: ClickClackDiscussionBinding | undefined,
    binding: ClickClackDiscussionBinding,
    options?: { assertCurrent?: () => void },
  ): Promise<boolean> {
    return await this.#mutateIfCurrent(sessionKey, expected, binding, options);
  }

  async observeCurrent(sessionKey: string): Promise<{
    binding: ClickClackDiscussionBinding | undefined;
    condition: PluginStateComparisonCondition;
  }> {
    return await this.#withMutation(async () => {
      const observed = await this.#workerStore().observe(sessionKey);
      this.#publish(sessionKey, observed.value);
      return {
        binding: observed.value,
        condition: {
          namespace: DISCUSSION_BINDINGS_NAMESPACE,
          key: sessionKey,
          comparison: observed.comparison,
        },
      };
    });
  }

  async deleteIfCurrent(
    sessionKey: string,
    expected: ClickClackDiscussionBinding,
    options?: { assertCurrent?: () => void },
  ): Promise<boolean> {
    return await this.#mutateIfCurrent(sessionKey, expected, undefined, options);
  }

  async #mutateIfCurrent(
    sessionKey: string,
    expected: ClickClackDiscussionBinding | undefined,
    next: ClickClackDiscussionBinding | undefined,
    options?: { assertCurrent?: () => void },
  ): Promise<boolean> {
    return await this.#withMutation(async () => {
      const worker = this.#workerStore();
      const observed = await worker.observe(sessionKey);
      if (!isDeepStrictEqual(observed.value, expected)) {
        this.#publish(sessionKey, observed.value);
        return false;
      }
      let authorityRejected = false;
      try {
        const guarded = options?.assertCurrent
          ? this.#runtime.state.openKeyedStoreV2<ClickClackDiscussionBinding>(
              BINDING_STORE_OPTIONS,
              {
                assertCurrent: () => {
                  try {
                    options.assertCurrent?.();
                  } catch (error) {
                    authorityRejected = true;
                    throw error;
                  }
                },
              },
            )
          : worker;
        const result = await guarded.compareAndApply(
          sessionKey,
          observed.comparison,
          next
            ? { operation: "update", action: "set", value: next }
            : { operation: "delete", action: "delete" },
        );
        this.#publish(sessionKey, result.status === "conflict" ? result.current.value : next);
        return result.status === "applied";
      } catch (error) {
        // An old session guard can lose authority while its worker request waits.
        // Only an observed replacement makes that failure an obsolete operation.
        if (!authorityRejected) {
          throw error;
        }
        const current = await worker.observe(sessionKey);
        if (current.comparison === observed.comparison) {
          throw error;
        }
        this.#publish(sessionKey, current.value);
        return false;
      }
    });
  }

  #publish(sessionKey: string, binding: ClickClackDiscussionBinding | undefined): void {
    if (!this.#prepared) {
      this.#changedDuringPreparation.add(sessionKey);
    }
    this.#unindex(sessionKey);
    if (binding) {
      this.#index(sessionKey, binding);
    }
  }

  async entries(): Promise<Array<{ sessionKey: string; binding: ClickClackDiscussionBinding }>> {
    const load = async () =>
      (await this.#workerStore().entries()).map((entry) => ({
        sessionKey: entry.key,
        binding: entry.value,
      }));
    if (this.#prepared) {
      return await load();
    }
    this.#preparing ??= load()
      .then((entries) => {
        for (const { sessionKey, binding } of entries) {
          // A mutation may commit while the worker snapshot is in flight.
          if (!this.#changedDuringPreparation.has(sessionKey)) {
            this.#index(sessionKey, binding);
          }
        }
        this.#prepared = true;
        this.#changedDuringPreparation.clear();
        return entries;
      })
      .finally(() => {
        this.#preparing = undefined;
      });
    return await this.#preparing;
  }

  async countAsync(): Promise<number> {
    return await this.#workerStore().count();
  }

  detachedCount(): number {
    return this.#detachedAtBySession.size;
  }

  #workerStore(): PluginStateKeyedStore<ClickClackDiscussionBinding, 2> {
    return (this.#store ??=
      this.#runtime.state.openKeyedStoreV2<ClickClackDiscussionBinding>(BINDING_STORE_OPTIONS));
  }

  async oldestDetached(): Promise<
    { sessionKey: string; binding: ClickClackDiscussionBinding } | undefined
  > {
    let oldestSessionKey: string | undefined;
    let oldestDetachedAt = Number.POSITIVE_INFINITY;
    for (const [sessionKey, detachedAt] of this.#detachedAtBySession) {
      if (
        detachedAt < oldestDetachedAt ||
        (detachedAt === oldestDetachedAt &&
          (oldestSessionKey === undefined || sessionKey < oldestSessionKey))
      ) {
        oldestSessionKey = sessionKey;
        oldestDetachedAt = detachedAt;
      }
    }
    if (!oldestSessionKey) {
      return undefined;
    }
    const binding = await this.getAsync(oldestSessionKey);
    if (!binding || binding.detachedAt === undefined) {
      if (this.#detachedAtBySession.get(oldestSessionKey) === oldestDetachedAt) {
        this.#detachedAtBySession.delete(oldestSessionKey);
      }
      return this.oldestDetached();
    }
    return { sessionKey: oldestSessionKey, binding };
  }

  #index(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    const channel = channelKey(binding.serverBaseUrl, binding.channelId);
    this.#channelBySession.set(sessionKey, channel);
    this.#sessionByChannel.set(channel, sessionKey);
    if (binding.detachedAt !== undefined) {
      this.#detachedAtBySession.set(sessionKey, binding.detachedAt);
    }
  }

  #unindex(sessionKey: string): void {
    const channel = this.#channelBySession.get(sessionKey);
    this.#channelBySession.delete(sessionKey);
    if (channel) {
      this.#sessionByChannel.delete(channel);
    }
    this.#detachedAtBySession.delete(sessionKey);
  }
}

export function getClickClackDiscussionBindingStore(
  runtime: PluginRuntime,
): ClickClackDiscussionBindingStore {
  const existing = storesByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new ClickClackDiscussionBindingStore(runtime);
  storesByRuntime.set(runtime, created);
  return created;
}
