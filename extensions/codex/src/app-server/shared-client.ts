import path from "node:path";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerFallbackApiKeyCacheKey,
} from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { applyCodexAppServerLogRetention } from "./log-retention.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  activeLeases: number;
  closeWhenIdle: boolean;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  leasedReleases: WeakMap<CodexAppServerClient, Array<() => void>>;
};

type LegacySharedCodexAppServerClientState = Partial<SharedCodexAppServerClientEntry> & {
  key?: string;
  clients?: unknown;
};

type KeyedSharedCodexAppServerClientState = {
  clients: Map<string, Partial<SharedCodexAppServerClientEntry>>;
  leasedReleases?: unknown;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");
const CODEX_LOG_RETENTION_STARTUP_STATE = Symbol.for(
  "openclaw.codexAppServerLogRetentionStartupState",
);

type CodexLogRetentionStartupState = {
  activeByHome: Map<string, number>;
  startingByHome: Map<string, { promise: Promise<void>; resolve: () => void }>;
};

type CodexLogRetentionStartupGuard = {
  shouldApplyRetention: boolean;
  waitForPriorStartup: () => Promise<void>;
  trackStartedClient: (client: CodexAppServerClient) => void;
  release: () => void;
};

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: unknown;
  };
  const state = globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
  const keyedState = readKeyedSharedCodexAppServerClientState(state);
  if (keyedState) {
    const clients = keyedState.clients as Map<string, SharedCodexAppServerClientEntry>;
    for (const entry of clients.values()) {
      entry.activeLeases ??= 0;
      entry.closeWhenIdle ??= false;
    }
    const nextState: SharedCodexAppServerClientState = {
      clients,
      leasedReleases:
        keyedState.leasedReleases instanceof WeakMap ? keyedState.leasedReleases : new WeakMap(),
    };
    globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] = nextState;
    return nextState;
  }
  const legacyState = readLegacySharedCodexAppServerClientState(state);
  const clients = new Map<string, SharedCodexAppServerClientEntry>();
  if (legacyState?.key && (legacyState.client || legacyState.promise)) {
    const legacyKey = legacyState.key;
    clients.set(legacyKey, {
      client: legacyState.client,
      promise: legacyState.promise,
      activeLeases: 0,
      closeWhenIdle: false,
    });
    legacyState.client?.addCloseHandler((closedClient) =>
      clearSharedClientEntryIfCurrent(legacyKey, closedClient),
    );
  }
  const nextState: SharedCodexAppServerClientState = { clients, leasedReleases: new WeakMap() };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] = nextState;
  return nextState;
}

function getCodexLogRetentionStartupState(): CodexLogRetentionStartupState {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_LOG_RETENTION_STARTUP_STATE]?: CodexLogRetentionStartupState;
  };
  const state = globalState[CODEX_LOG_RETENTION_STARTUP_STATE];
  if (state) {
    return state;
  }
  const nextState: CodexLogRetentionStartupState = {
    activeByHome: new Map(),
    startingByHome: new Map(),
  };
  globalState[CODEX_LOG_RETENTION_STARTUP_STATE] = nextState;
  return nextState;
}

function readKeyedSharedCodexAppServerClientState(
  value: unknown,
): KeyedSharedCodexAppServerClientState | undefined {
  return value !== null &&
    typeof value === "object" &&
    (value as { clients?: unknown }).clients instanceof Map
    ? (value as KeyedSharedCodexAppServerClientState)
    : undefined;
}

function readLegacySharedCodexAppServerClientState(
  value: unknown,
): LegacySharedCodexAppServerClientState | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as LegacySharedCodexAppServerClientState;
}

function beginCodexLogRetentionStartup(
  startOptions: CodexAppServerStartOptions,
): CodexLogRetentionStartupGuard {
  const codexHome = normalizeCodexHomeForRetention(startOptions);
  if (!codexHome) {
    return {
      shouldApplyRetention: false,
      waitForPriorStartup: async () => undefined,
      trackStartedClient: () => undefined,
      release: () => undefined,
    };
  }
  const state = getCodexLogRetentionStartupState();
  const hasActiveHome = (state.activeByHome.get(codexHome) ?? 0) > 0;
  const startingHome = state.startingByHome.get(codexHome);
  const shouldApplyRetention = !hasActiveHome && !startingHome;
  let startedHome: { promise: Promise<void>; resolve: () => void } | undefined;
  if (shouldApplyRetention) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    startedHome = { promise, resolve };
    state.startingByHome.set(codexHome, startedHome);
  }
  let tracked = false;
  let released = false;
  const releaseStartingHome = () => {
    if (!released && shouldApplyRetention) {
      state.startingByHome.delete(codexHome);
      startedHome?.resolve();
    }
    released = true;
  };
  return {
    shouldApplyRetention,
    waitForPriorStartup: startingHome ? () => startingHome.promise : async () => undefined,
    trackStartedClient: (client) => {
      if (tracked) {
        return;
      }
      tracked = true;
      releaseStartingHome();
      state.activeByHome.set(codexHome, (state.activeByHome.get(codexHome) ?? 0) + 1);
      client.addCloseHandler(() => releaseCodexLogRetentionActiveHome(codexHome));
    },
    release: releaseStartingHome,
  };
}

function releaseCodexLogRetentionActiveHome(codexHome: string): void {
  const state = getCodexLogRetentionStartupState();
  const activeCount = state.activeByHome.get(codexHome) ?? 0;
  if (activeCount <= 1) {
    state.activeByHome.delete(codexHome);
    return;
  }
  state.activeByHome.set(codexHome, activeCount - 1);
}

function normalizeCodexHomeForRetention(
  startOptions: CodexAppServerStartOptions,
): string | undefined {
  if (startOptions.transport !== "stdio") {
    return undefined;
  }
  const codexHome = startOptions.env?.CODEX_HOME?.trim();
  return codexHome ? path.resolve(codexHome) : undefined;
}

type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
};

type ResolvedCodexAppServerClientStartContext = {
  agentDir: string;
  usesNativeAuth: boolean;
  authProfileId: string | undefined;
  startOptions: CodexAppServerStartOptions;
};

async function resolveCodexAppServerClientStartContext(
  options?: CodexAppServerClientOptions,
): Promise<ResolvedCodexAppServerClientStartContext> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  return { agentDir, usesNativeAuth, authProfileId, startOptions };
}

export async function getSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  return (await acquireSharedCodexAppServerClient(options)).client;
}

export async function getLeasedSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const acquired = await acquireSharedCodexAppServerClient(options, { leased: true });
  const state = getSharedCodexAppServerClientState();
  const releases = state.leasedReleases.get(acquired.client) ?? [];
  releases.push(acquired.release);
  state.leasedReleases.set(acquired.client, releases);
  return acquired.client;
}

export function releaseLeasedSharedCodexAppServerClient(client: CodexAppServerClient): boolean {
  const state = getSharedCodexAppServerClientState();
  const releases = state.leasedReleases.get(client);
  if (!releases) {
    return false;
  }
  const release = releases.pop();
  if (!release) {
    return false;
  }
  if (releases.length === 0) {
    state.leasedReleases.delete(client);
  }
  release();
  return true;
}

async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<{ client: CodexAppServerClient }>;
async function acquireSharedCodexAppServerClient(
  options: CodexAppServerClientOptions | undefined,
  leaseOptions: { leased: true },
): Promise<{ client: CodexAppServerClient; release: () => void }>;
async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
  leaseOptions?: { leased: true },
): Promise<{ client: CodexAppServerClient; release?: () => void }> {
  const { agentDir, usesNativeAuth, authProfileId, startOptions } =
    await resolveCodexAppServerClientStartContext(options);
  const fallbackApiKeyCacheKey = authProfileId
    ? undefined
    : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir: usesNativeAuth ? undefined : agentDir,
    fallbackApiKeyCacheKey,
  });
  const state = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(state, key);
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const retentionStartup = beginCodexLogRetentionStartup(startOptions);
      let client: CodexAppServerClient | undefined;
      try {
        await retentionStartup.waitForPriorStartup();
        if (retentionStartup.shouldApplyRetention) {
          await applyCodexAppServerLogRetention({ startOptions });
        }
        client = CodexAppServerClient.start(startOptions);
        retentionStartup.trackStartedClient(client);
        entry.client = client;
        client.setActiveSharedLeaseCountProviderForUnscopedNotifications(() => entry.activeLeases);
      } catch (error) {
        retentionStartup.release();
        throw error;
      }
      client.addCloseHandler((closedClient) => clearSharedClientEntryIfCurrent(key, closedClient));
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId: usesNativeAuth ? null : authProfileId,
          startOptions,
          config: options?.config,
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
    const client = await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
    client.setActiveSharedLeaseCountProviderForUnscopedNotifications(() => entry.activeLeases);
    const release = leaseOptions?.leased ? retainSharedClientEntry(entry) : undefined;
    return release ? { client, release } : { client };
  } catch (error) {
    const currentEntry = state.clients.get(key);
    if (currentEntry?.promise === sharedPromise) {
      clearSharedClientEntry(key, currentEntry);
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const { agentDir, usesNativeAuth, authProfileId, startOptions } =
    await resolveCodexAppServerClientStartContext(options);
  const retentionStartup = beginCodexLogRetentionStartup(startOptions);
  let client: CodexAppServerClient;
  try {
    await retentionStartup.waitForPriorStartup();
    if (retentionStartup.shouldApplyRetention) {
      await applyCodexAppServerLogRetention({ startOptions });
    }
    client = CodexAppServerClient.start(startOptions);
    retentionStartup.trackStartedClient(client);
  } catch (error) {
    retentionStartup.release();
    throw error;
  }
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId: usesNativeAuth ? null : authProfileId,
      startOptions,
      config: options?.config,
    });
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  const retentionState = getCodexLogRetentionStartupState();
  retentionState.activeByHome.clear();
  retentionState.startingByHome.clear();
  state.leasedReleases = new WeakMap();
  for (const client of clients) {
    client.close();
  }
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  for (const client of clients) {
    client.close();
  }
}

export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      client.close();
      return true;
    }
  }
  return false;
}

export function detachSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      return true;
    }
  }
  return false;
}

export function retainSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): (() => void) | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    if (entry.client === client) {
      return retainSharedClientEntry(entry);
    }
  }
  return undefined;
}

export function retireSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): { activeLeases: number; closed: boolean } | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      entry.closeWhenIdle = true;
      const closed = closeRetiredSharedClientEntryIfIdle(entry);
      return { activeLeases: entry.activeLeases, closed };
    }
  }
  const activeLeases = state.leasedReleases.get(client)?.length ?? 0;
  if (activeLeases > 0) {
    return { activeLeases, closed: false };
  }
  return undefined;
}

export async function clearSharedCodexAppServerClientIfCurrentAndWait(
  client: CodexAppServerClient | undefined,
  options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  },
): Promise<boolean> {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      await client.closeAndWait(options);
      return true;
    }
  }
  return false;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = { activeLeases: 0, closeWhenIdle: false };
    state.clients.set(key, entry);
  }
  return entry;
}

function clearSharedClientEntry(key: string, entry: SharedCodexAppServerClientEntry): void {
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(key) !== entry) {
    return;
  }
  state.clients.delete(key);
  entry.client?.close();
}

function clearSharedClientEntryIfCurrent(key: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.clients.get(key);
  if (entry?.client === client) {
    state.clients.delete(key);
  }
}

function retainSharedClientEntry(entry: SharedCodexAppServerClientEntry): () => void {
  let released = false;
  entry.activeLeases += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);
    closeRetiredSharedClientEntryIfIdle(entry);
  };
}

function closeRetiredSharedClientEntryIfIdle(entry: SharedCodexAppServerClientEntry): boolean {
  if (!entry.closeWhenIdle || entry.activeLeases > 0 || !entry.client) {
    return false;
  }
  const client = entry.client;
  entry.closeWhenIdle = false;
  entry.client = undefined;
  client.close();
  return true;
}

function collectSharedClients(state: SharedCodexAppServerClientState): CodexAppServerClient[] {
  return [
    ...new Set(
      [...state.clients.values()]
        .map((entry) => entry.client)
        .filter((client): client is CodexAppServerClient => Boolean(client)),
    ),
  ];
}
