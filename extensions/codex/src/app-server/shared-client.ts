/**
 * Owns shared and isolated Codex app-server client startup, auth application,
 * lease tracking, and teardown.
 */
import { resolveDefaultAgentDir, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerFallbackApiKeyCacheKey,
} from "./auth-bridge.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  key: string;
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  startContext?: ResolvedCodexAppServerClientStartContext;
  activeLeases: number;
  pendingAcquires: number;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  idle: Map<string, SharedCodexAppServerClientEntry>;
  retiring: Map<CodexAppServerClient, Promise<void>>;
};

const sharedClientState: SharedCodexAppServerClientState = {
  clients: new Map(),
  idle: new Map(),
  retiring: new Map(),
};
const MAX_IDLE_SHARED_CLIENTS = 4;
const sharedClientEntries = new WeakMap<CodexAppServerClient, SharedCodexAppServerClientEntry>();
// Revalidate credentials for each acquisition, but coalesce concurrent callers
// so managed-binary and secret preparation still has one owner.
const pendingStartContexts = new Map<
  string,
  Promise<{ key: string; startContext: ResolvedCodexAppServerClientStartContext }>
>();
let managedCommandResolution:
  | Promise<Pick<CodexAppServerStartOptions, "command" | "commandSource">>
  | undefined;

/** One caller's exact ownership of a shared physical app-server client. */
export type CodexAppServerClientLease = {
  readonly client: CodexAppServerClient;
  readonly release: () => void;
  readonly abandon: () => Promise<void>;
};

/** Inputs that identify and bound one shared-client acquisition. */
export type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  preparedAuth?: {
    profileId?: string;
    cacheKey?: string;
  };
  authProfileStore?: AuthProfileStore;
  abandonSignal?: AbortSignal;
};

/** Injectable acquisition contract that preserves exact client ownership. */
export type CodexAppServerClientLeaseFactory = (
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClientLease>;

type ResolvedCodexAppServerClientStartContext = {
  agentDir: string;
  usesNativeAuth: boolean;
  authProfileId: string | undefined;
  authProfileStore: AuthProfileStore | undefined;
  startOptions: CodexAppServerStartOptions;
  config: CodexAppServerClientOptions["config"];
  preparedAuth: CodexAppServerClientOptions["preparedAuth"];
};

type RequestedCodexAppServerClientStartContext = {
  agentDir: string;
  usesNativeAuth: boolean;
  requestedAuthProfileId: string | undefined;
  startOptions: CodexAppServerStartOptions;
  config: CodexAppServerClientOptions["config"];
  preparedAuth: CodexAppServerClientOptions["preparedAuth"];
  authProfileStore: AuthProfileStore | undefined;
};

function resolveRequestedCodexAppServerClientStartContext(
  options?: CodexAppServerClientOptions,
): RequestedCodexAppServerClientStartContext {
  const agentDir = options?.agentDir?.trim() || resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId?.trim() || undefined;
  return {
    agentDir,
    usesNativeAuth,
    requestedAuthProfileId,
    startOptions: options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start,
    config: options?.config,
    preparedAuth: options?.preparedAuth,
    authProfileStore: options?.authProfileStore,
  };
}

async function prepareCodexAppServerClientStartContext(
  requested: RequestedCodexAppServerClientStartContext,
): Promise<ResolvedCodexAppServerClientStartContext> {
  const requestedAuthProfileId =
    requested.preparedAuth?.profileId ?? requested.requestedAuthProfileId;
  const authProfileStore =
    !requested.usesNativeAuth && requested.authProfileStore
      ? resolveCodexAppServerAuthProfileStore({
          agentDir: requested.agentDir,
          authProfileId: requestedAuthProfileId,
          authProfileStore: requested.authProfileStore,
          config: requested.config,
        })
      : requested.authProfileStore;
  const authProfileId = requested.usesNativeAuth
    ? undefined
    : requested.preparedAuth
      ? requested.preparedAuth.profileId
      : (requested.requestedAuthProfileId ??
        resolveCodexAppServerAuthProfileIdForAgent({
          agentDir: requested.agentDir,
          config: requested.config,
          ...(authProfileStore ? { authProfileStore } : {}),
        }));
  const managedStartOptions = await resolveProcessManagedStartOptions(requested.startOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir: requested.agentDir,
    authProfileId: requested.usesNativeAuth ? null : authProfileId,
    config: requested.config,
    ...(authProfileStore ? { authProfileStore } : {}),
  });
  return { ...requested, authProfileId, authProfileStore, startOptions };
}

async function resolveProcessManagedStartOptions(
  startOptions: CodexAppServerStartOptions,
): Promise<CodexAppServerStartOptions> {
  if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") {
    return startOptions;
  }
  // The installed managed binary path is process-stable. Cache only that fact;
  // credentials and the rest of the caller's start options still refresh per acquire.
  managedCommandResolution ??= resolveManagedCodexAppServerStartOptions(startOptions).then(
    (resolved) => ({
      command: resolved.command,
      commandSource: resolved.commandSource,
    }),
  );
  return { ...startOptions, ...(await managedCommandResolution) };
}

function sharedCodexAppServerClientKey(
  requested: RequestedCodexAppServerClientStartContext,
): string {
  // Explicit/native/prepared auth scopes are stable for one client lifecycle,
  // so their cache hits must not repeat managed-binary/auth/home discovery.
  const authScope = requested.usesNativeAuth
    ? ["native"]
    : requested.preparedAuth
      ? [
          "prepared",
          requested.preparedAuth.profileId ?? null,
          requested.preparedAuth.cacheKey ?? null,
        ]
      : requested.requestedAuthProfileId
        ? ["profile", requested.requestedAuthProfileId]
        : ["implicit"];
  return JSON.stringify([
    codexAppServerStartOptionsKey(requested.startOptions, { agentDir: requested.agentDir }),
    authScope,
  ]);
}

async function resolveSharedCodexAppServerClientStart(
  requested: RequestedCodexAppServerClientStartContext,
): Promise<{ key: string; startContext?: ResolvedCodexAppServerClientStartContext }> {
  if (requested.usesNativeAuth || requested.preparedAuth !== undefined) {
    return { key: sharedCodexAppServerClientKey(requested) };
  }
  // Scoped stores are caller-owned snapshots. Do not coalesce their preparation
  // before the credential-derived final key is known.
  const pendingKey = requested.authProfileStore
    ? undefined
    : sharedCodexAppServerClientKey(requested);
  const existing = pendingKey ? pendingStartContexts.get(pendingKey) : undefined;
  if (existing) {
    return await existing;
  }
  // Implicit selection can change with auth order, cooldowns, env keys, or
  // Codex auth.json. Resolve it before sharing to preserve credential rotation.
  const pending = (async () => {
    const startContext = await prepareCodexAppServerClientStartContext(requested);
    const fallbackApiKeyCacheKey = startContext.authProfileId
      ? undefined
      : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: startContext.startOptions });
    const authAccountCacheKey = startContext.authProfileId
      ? await resolveCodexAppServerAuthAccountCacheKey({
          authProfileId: startContext.authProfileId,
          agentDir: startContext.agentDir,
          config: startContext.config,
          ...(startContext.authProfileStore
            ? { authProfileStore: startContext.authProfileStore }
            : {}),
        })
      : undefined;
    return {
      key: codexAppServerStartOptionsKey(startContext.startOptions, {
        authProfileId: startContext.authProfileId,
        authAccountCacheKey,
        agentDir: startContext.agentDir,
        fallbackApiKeyCacheKey,
      }),
      startContext,
    };
  })();
  if (pendingKey) {
    pendingStartContexts.set(pendingKey, pending);
  }
  try {
    return await pending;
  } finally {
    if (pendingKey && pendingStartContexts.get(pendingKey) === pending) {
      pendingStartContexts.delete(pendingKey);
    }
  }
}

/** Leases a shared Codex app-server client to one exact caller. */
export async function leaseSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClientLease> {
  const acquired = await acquireSharedCodexAppServerClient(options);
  return createSharedClientLease(acquired);
}

/** Pins a pooled physical client while detached work still depends on it. */
export function retainSharedCodexAppServerClient(client: CodexAppServerClient): () => void {
  const entry = sharedClientEntries.get(client);
  if (!entry || entry.client !== client) {
    return () => undefined;
  }
  if (sharedClientState.idle.get(entry.key) === entry) {
    sharedClientState.idle.delete(entry.key);
  }
  entry.activeLeases += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseSharedClientOwnership(entry);
  };
}

async function acquireSharedCodexAppServerClient(options?: CodexAppServerClientOptions): Promise<{
  client: CodexAppServerClient;
  entry: SharedCodexAppServerClientEntry;
}> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 0;
  const requested = resolveRequestedCodexAppServerClientStartContext(options);
  const { key, startContext: preparedStartContext } = await waitForClientAcquireStage(
    resolveSharedCodexAppServerClientStart(requested),
    {
      signal: options?.abandonSignal,
      timeoutMs: remainingClientAcquireTimeout(timeoutMs, startedAt),
      timeoutMessage: "codex app-server preparation timed out",
    },
  );
  options?.abandonSignal?.throwIfAborted();
  const state = sharedClientState;
  const entry = getOrCreateSharedClientEntry(state, key);
  state.idle.delete(key);
  const releasePendingAcquire = retainPendingSharedClientAcquire(entry);
  let cleanupAbandonSignal: (() => void) | undefined;
  if (options?.abandonSignal) {
    const abandon = () => {
      // Release this acquire before cleanup checks ownership; only other
      // pending callers should keep the startup client alive.
      releasePendingAcquire();
      closeSharedClientEntryIfUnclaimed(entry);
    };
    options.abandonSignal.addEventListener("abort", abandon, { once: true });
    cleanupAbandonSignal = () => options.abandonSignal?.removeEventListener("abort", abandon);
    if (options.abandonSignal.aborted) {
      abandon();
    }
  }
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const startContext =
        preparedStartContext ?? (await prepareCodexAppServerClientStartContext(requested));
      if (state.clients.get(key) !== entry) {
        throw new Error("Codex app-server startup was abandoned before launch");
      }
      entry.startContext = startContext;
      const { agentDir, usesNativeAuth, authProfileId, startOptions } = startContext;
      const client = CodexAppServerClient.start(startOptions);
      ensureCodexAppServerClientRuntime(client, {
        agentDir,
        authProfileId,
        config: startContext.config,
        ...(startContext.authProfileStore
          ? { authProfileStore: startContext.authProfileStore }
          : {}),
      });
      entry.client = client;
      sharedClientEntries.set(client, entry);
      client.addCloseHandler((closedClient) =>
        clearSharedClientEntryIfCurrent(entry, closedClient),
      );
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId: usesNativeAuth ? null : authProfileId,
          startOptions,
          config: startContext.config,
          ...(startContext.authProfileStore
            ? { authProfileStore: startContext.authProfileStore }
            : {}),
        });
        return client;
      } catch (error) {
        // Startup failures happen before callers own the shared client, so close
        // the child here instead of leaving a rejected daemon attached to stdio.
        client.close();
        throw error;
      }
    })());
  try {
    const client = await waitForClientAcquireStage(sharedPromise, {
      signal: options?.abandonSignal,
      timeoutMs: remainingClientAcquireTimeout(timeoutMs, startedAt),
      timeoutMessage: "codex app-server initialize timed out",
    });
    options?.abandonSignal?.throwIfAborted();
    const startContext = entry.startContext;
    if (!startContext) {
      throw new Error("Codex app-server shared client started without a prepared context");
    }
    if (state.clients.get(key) !== entry || entry.client !== client) {
      throw new Error("Codex app-server shared client was abandoned during acquisition");
    }
    ensureCodexAppServerClientRuntime(client, {
      agentDir: startContext.agentDir,
      authProfileId: startContext.authProfileId,
      config: options?.config ?? startContext.config,
      ...(startContext.authProfileStore ? { authProfileStore: startContext.authProfileStore } : {}),
    });
    entry.activeLeases += 1;
    return { client, entry };
  } catch (error) {
    // A caller-local timeout must not tear down startup while another acquire
    // still owns it. Actual startup rejection reaches every pending caller, so
    // the last one still evicts and closes the failed entry.
    releasePendingAcquire();
    closeSharedClientEntryIfUnclaimed(entry);
    throw error;
  } finally {
    cleanupAbandonSignal?.();
    releasePendingAcquire();
  }
}

function remainingClientAcquireTimeout(timeoutMs: number, startedAt: number): number {
  return timeoutMs > 0 ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : 0;
}

async function waitForClientAcquireStage<T>(
  operation: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs: number; timeoutMessage: string },
): Promise<T> {
  options.signal?.throwIfAborted();
  const bounded = withTimeout(operation, options.timeoutMs, options.timeoutMessage);
  if (!options.signal) {
    return await bounded;
  }
  const signal = options.signal;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      const reason = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error("codex app-server client acquisition aborted", { cause: reason }),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    bounded.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Starts a non-shared Codex app-server client owned entirely by the caller. */
export async function createIsolatedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const requested = resolveRequestedCodexAppServerClientStartContext(options);
  const startedAt = Date.now();
  const { agentDir, usesNativeAuth, authProfileId, authProfileStore, startOptions } =
    await waitForClientAcquireStage(prepareCodexAppServerClientStartContext(requested), {
      signal: options?.abandonSignal,
      timeoutMs: remainingClientAcquireTimeout(options?.timeoutMs ?? 0, startedAt),
      timeoutMessage: "codex app-server preparation timed out",
    });
  options?.abandonSignal?.throwIfAborted();
  const client = CodexAppServerClient.start(startOptions);
  ensureCodexAppServerClientRuntime(client, {
    agentDir,
    authProfileId,
    config: options?.config,
    ...(authProfileStore ? { authProfileStore } : {}),
  });
  const startup = (async () => {
    await client.initialize();
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId: usesNativeAuth ? null : authProfileId,
      startOptions,
      config: options?.config,
      ...(authProfileStore ? { authProfileStore } : {}),
    });
    return client;
  })();
  try {
    return await waitForClientAcquireStage(startup, {
      signal: options?.abandonSignal,
      timeoutMs: remainingClientAcquireTimeout(options?.timeoutMs ?? 0, startedAt),
      timeoutMessage: "codex app-server initialize timed out",
    });
  } catch (error) {
    client.close();
    void startup.catch(() => undefined);
    throw error;
  }
}

/** Clears and closes all shared clients for deterministic tests. */
export function resetSharedCodexAppServerClientForTests(): void {
  pendingStartContexts.clear();
  managedCommandResolution = undefined;
  for (const client of detachAllSharedClients()) {
    client.close();
  }
  for (const client of sharedClientState.retiring.keys()) {
    client.close();
  }
  sharedClientState.retiring.clear();
}

/** Clears all shared clients and waits for their processes to exit. */
export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  managedCommandResolution = undefined;
  for (const client of detachAllSharedClients()) {
    void retireSharedClientAndWait(client, options);
  }
  await Promise.all(sharedClientState.retiring.values());
}

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = { key, activeLeases: 0, pendingAcquires: 0 };
    state.clients.set(key, entry);
  }
  return entry;
}

function clearSharedClientEntryIfCurrent(
  entry: SharedCodexAppServerClientEntry,
  client: CodexAppServerClient,
): void {
  detachSharedClientEntry(entry, client);
}

function retainPendingSharedClientAcquire(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.pendingAcquires += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.pendingAcquires -= 1;
  };
}

function createSharedClientLease(acquired: {
  client: CodexAppServerClient;
  entry: SharedCodexAppServerClientEntry;
}): CodexAppServerClientLease {
  let settled = false;
  return {
    client: acquired.client,
    release: () => {
      if (settled) {
        return;
      }
      settled = true;
      releaseSharedClientOwnership(acquired.entry);
    },
    abandon: async () => {
      if (settled) {
        return;
      }
      settled = true;
      acquired.entry.activeLeases -= 1;
      const client = detachSharedClientEntry(acquired.entry);
      if (client) {
        await retireSharedClientAndWait(client);
      }
    },
  };
}

function releaseSharedClientOwnership(entry: SharedCodexAppServerClientEntry): void {
  entry.activeLeases -= 1;
  retainIdleSharedClient(entry);
}

function retainIdleSharedClient(releasedEntry: SharedCodexAppServerClientEntry): void {
  const state = sharedClientState;
  if (
    releasedEntry.activeLeases !== 0 ||
    releasedEntry.pendingAcquires !== 0 ||
    state.clients.get(releasedEntry.key) !== releasedEntry ||
    !releasedEntry.client
  ) {
    return;
  }
  state.idle.delete(releasedEntry.key);
  state.idle.set(releasedEntry.key, releasedEntry);
  while (state.idle.size > MAX_IDLE_SHARED_CLIENTS) {
    const oldest = state.idle.entries().next().value;
    if (!oldest) {
      return;
    }
    const [key, entry] = oldest;
    state.idle.delete(key);
    if (state.clients.get(key) !== entry) {
      continue;
    }
    const client = detachSharedClientEntry(entry);
    if (client) {
      retireSharedClient(client);
    }
  }
}

function closeSharedClientEntryIfUnclaimed(entry: SharedCodexAppServerClientEntry): void {
  if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return;
  }
  const state = sharedClientState;
  if (state.clients.get(entry.key) !== entry) {
    return;
  }
  const client = detachSharedClientEntry(entry);
  if (client) {
    retireSharedClient(client);
  }
}

function retireSharedClient(client: CodexAppServerClient): void {
  void retireSharedClientAndWait(client).catch(() => undefined);
}

function retireSharedClientAndWait(
  client: CodexAppServerClient,
  options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  },
): Promise<void> {
  const state = sharedClientState;
  const current = state.retiring.get(client);
  if (current) {
    return current;
  }
  const retirement = client.closeAndWait(options);
  state.retiring.set(client, retirement);
  void retirement.then(
    () => {
      if (state.retiring.get(client) === retirement) {
        state.retiring.delete(client);
      }
    },
    () => {
      if (state.retiring.get(client) === retirement) {
        state.retiring.delete(client);
      }
    },
  );
  return retirement;
}

function detachSharedClientEntry(
  entry: SharedCodexAppServerClientEntry,
  expectedClient?: CodexAppServerClient,
): CodexAppServerClient | undefined {
  const state = sharedClientState;
  const client = entry.client;
  if (expectedClient && client !== expectedClient) {
    return undefined;
  }
  // Pending entries have no client yet but still need detaching; otherwise a
  // timed-out sole acquire can finish preparation and launch an orphan process.
  if (state.clients.get(entry.key) === entry) {
    state.clients.delete(entry.key);
  }
  if (state.idle.get(entry.key) === entry) {
    state.idle.delete(entry.key);
  }
  if (client) {
    entry.client = undefined;
    sharedClientEntries.delete(client);
  }
  return client;
}

function detachAllSharedClients(): CodexAppServerClient[] {
  const state = sharedClientState;
  const entries = new Set(state.clients.values());
  const clients = [...entries]
    .map((entry) => detachSharedClientEntry(entry))
    .filter((client): client is CodexAppServerClient => Boolean(client));
  state.clients.clear();
  state.idle.clear();
  return [...new Set(clients)];
}
