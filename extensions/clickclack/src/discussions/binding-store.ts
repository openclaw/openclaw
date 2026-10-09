import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
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
  // Released hosts predate the worker companion. Select their native contract
  // before reading; a failed worker read never falls back to native storage.
  return runtime.agent.session.getSessionEntryAsync
    ? await runtime.agent.session.getSessionEntryAsync(params)
    : runtime.agent.session.getSessionEntry(params);
}

/**
 * Refresh the replaceable session attachment without changing the durable room identity.
 * The store registers persisted state before reindexing, so a failed write leaves the
 * previous attachment authoritative in both persistence and memory.
 */
export function attachBindingToCurrentActiveSession(params: {
  runtime: PluginRuntime;
  store: ClickClackDiscussionBindingStore;
  sessionKey: string;
  binding: ClickClackDiscussionBinding;
}): ClickClackDiscussionBinding | undefined {
  const entry = params.runtime.agent.session.getSessionEntry({
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  if (!entry?.sessionId || entry.archivedAt !== undefined) {
    return undefined;
  }
  if (entry.sessionId === params.binding.sessionId && params.binding.detachedAt === undefined) {
    return params.binding;
  }
  const { detachedAt: _detachedAt, ...retained } = params.binding;
  const attached = { ...retained, sessionId: entry.sessionId };
  params.store.set(params.sessionKey, attached);
  return attached;
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
  readonly #store: PluginStateSyncKeyedStore<ClickClackDiscussionBinding>;
  #asyncStore: PluginStateKeyedStore<ClickClackDiscussionBinding> | undefined;
  readonly #sessionByChannel = new Map<string, string>();
  readonly #detachedAtBySession = new Map<string, number>();
  readonly #channelBySession = new Map<string, string>();
  readonly #runtime: PluginRuntime;
  #prepared = false;
  #preparing:
    | Promise<Array<{ sessionKey: string; binding: ClickClackDiscussionBinding }>>
    | undefined;
  readonly #changedDuringPreparation = new Set<string>();

  constructor(runtime: PluginRuntime) {
    this.#runtime = runtime;
    this.#store =
      runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>(BINDING_STORE_OPTIONS);
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
    return this.#store.lookup(sessionKey);
  }

  async hasCapacity(sessionKey: string): Promise<boolean> {
    return (
      (await this.getAsync(sessionKey)) !== undefined ||
      (await this.countAsync()) < MAX_DISCUSSION_BINDINGS
    );
  }

  getByChannel(
    serverBaseUrl: string,
    channelId: string,
  ): { sessionKey: string; binding: ClickClackDiscussionBinding } | undefined {
    const key = channelKey(serverBaseUrl, channelId);
    const sessionKey = this.#sessionByChannel.get(key);
    if (!sessionKey) {
      return undefined;
    }
    const binding = this.get(sessionKey);
    if (!binding || channelKey(binding.serverBaseUrl, binding.channelId) !== key) {
      this.#sessionByChannel.delete(key);
      return undefined;
    }
    return { sessionKey, binding };
  }

  set(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    this.#store.register(sessionKey, binding);
    if (!this.#prepared) {
      this.#changedDuringPreparation.add(sessionKey);
    }
    this.#unindex(sessionKey);
    this.#index(sessionKey, binding);
  }

  delete(sessionKey: string): boolean {
    const deleted = this.#store.delete(sessionKey);
    if (deleted && !this.#prepared) {
      this.#changedDuringPreparation.add(sessionKey);
    }
    if (deleted) {
      this.#unindex(sessionKey);
    }
    return deleted;
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
          // A synchronous mutation may commit while the worker snapshot is in flight.
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
    const store = this.#workerStore();
    return store.count ? await store.count() : (await this.entries()).length;
  }

  detachedCount(): number {
    return this.#detachedAtBySession.size;
  }

  #workerStore(): PluginStateKeyedStore<ClickClackDiscussionBinding> {
    return (this.#asyncStore ??=
      this.#runtime.state.openKeyedStore<ClickClackDiscussionBinding>(BINDING_STORE_OPTIONS));
  }

  oldestDetached(): { sessionKey: string; binding: ClickClackDiscussionBinding } | undefined {
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
    const binding = this.get(oldestSessionKey);
    if (!binding || binding.detachedAt === undefined) {
      this.#detachedAtBySession.delete(oldestSessionKey);
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
