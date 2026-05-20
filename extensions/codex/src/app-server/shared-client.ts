import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  leases?: WeakMap<CodexAppServerClient, number>;
  retireWhenIdle?: WeakSet<CodexAppServerClient>;
};

type LegacySharedCodexAppServerClientState = Partial<SharedCodexAppServerClientEntry> & {
  key?: string;
  clients?: unknown;
  leases?: WeakMap<CodexAppServerClient, number>;
  retireWhenIdle?: WeakSet<CodexAppServerClient>;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: unknown;
  };
  const state = globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
  if (isSharedCodexAppServerClientState(state)) {
    return state;
  }
  const legacyState = readLegacySharedCodexAppServerClientState(state);
  const clients = new Map<string, SharedCodexAppServerClientEntry>();
  if (legacyState?.key && (legacyState.client || legacyState.promise)) {
    const legacyKey = legacyState.key;
    clients.set(legacyKey, { client: legacyState.client, promise: legacyState.promise });
    legacyState.client?.addCloseHandler((closedClient) =>
      clearSharedClientEntryIfCurrent(legacyKey, closedClient),
    );
  }
  const nextState: SharedCodexAppServerClientState = {
    clients,
    leases: legacyState?.leases,
    retireWhenIdle: legacyState?.retireWhenIdle,
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] = nextState;
  return nextState;
}

function isSharedCodexAppServerClientState(
  value: unknown,
): value is SharedCodexAppServerClientState {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { clients?: unknown }).clients instanceof Map
  );
}

function readLegacySharedCodexAppServerClientState(
  value: unknown,
): LegacySharedCodexAppServerClientState | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as LegacySharedCodexAppServerClientState;
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
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
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir: usesNativeAuth ? undefined : agentDir,
  });
  const state = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(state, key);
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      entry.client = client;
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
    return await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    const currentEntry = state.clients.get(key);
    if (currentEntry?.promise === sharedPromise) {
      clearSharedClientEntry(key, currentEntry);
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
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
  const client = CodexAppServerClient.start(startOptions);
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
  state.clients.clear();
  state.leases = new WeakMap();
  state.retireWhenIdle = new WeakSet();
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  state.leases = new WeakMap();
  state.retireWhenIdle = new WeakSet();
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
      state.leases?.delete(client);
      state.retireWhenIdle?.delete(client);
      client.close();
      return true;
    }
  }
  return false;
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
      state.leases?.delete(client);
      state.retireWhenIdle?.delete(client);
      await client.closeAndWait(options);
      return true;
    }
  }
  return false;
}

export function retainSharedCodexAppServerClient(
  client: CodexAppServerClient | undefined,
): () => void {
  if (!client) {
    return () => undefined;
  }
  const state = getSharedCodexAppServerClientState();
  if (!hasSharedClientEntry(state, client)) {
    return () => undefined;
  }
  state.leases ??= new WeakMap();
  state.retireWhenIdle ??= new WeakSet();
  state.leases.set(client, (state.leases.get(client) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const currentCount = state.leases?.get(client) ?? 0;
    if (currentCount <= 1) {
      state.leases?.delete(client);
      if (state.retireWhenIdle?.has(client)) {
        state.retireWhenIdle.delete(client);
        closeCodexAppServerClientIfAvailable(client);
      }
      return;
    }
    state.leases?.set(client, currentCount - 1);
  };
}

export function retireSharedCodexAppServerClient(client: CodexAppServerClient | undefined): {
  clearedSharedClient: boolean;
  closedClient: boolean;
  deferredSharedClientRetirement: boolean;
} {
  if (!client) {
    return {
      clearedSharedClient: false,
      closedClient: false,
      deferredSharedClientRetirement: false,
    };
  }
  const state = getSharedCodexAppServerClientState();
  const leaseCount = state.leases?.get(client) ?? 0;
  const deferClose = leaseCount > 0;
  const clearedSharedClient = deleteSharedClientEntries(state, client);
  if (deferClose) {
    state.retireWhenIdle ??= new WeakSet();
    state.retireWhenIdle.add(client);
    return {
      clearedSharedClient,
      closedClient: false,
      deferredSharedClientRetirement: true,
    };
  }
  state.leases?.delete(client);
  state.retireWhenIdle?.delete(client);
  const closedClient = closeCodexAppServerClientIfAvailable(client);
  return {
    clearedSharedClient,
    closedClient,
    deferredSharedClientRetirement: false,
  };
}

function closeCodexAppServerClientIfAvailable(client: CodexAppServerClient): boolean {
  const close = (client as { close?: () => void }).close;
  if (typeof close !== "function") {
    return false;
  }
  close.call(client);
  return true;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  state.clients.clear();
  state.leases = new WeakMap();
  state.retireWhenIdle = new WeakSet();
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = {};
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
  if (entry.client) {
    state.leases?.delete(entry.client);
    state.retireWhenIdle?.delete(entry.client);
  }
  entry.client?.close();
}

function clearSharedClientEntryIfCurrent(key: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.clients.get(key);
  if (entry?.client === client) {
    state.clients.delete(key);
    state.leases?.delete(client);
    state.retireWhenIdle?.delete(client);
  }
}

function hasSharedClientEntry(
  state: SharedCodexAppServerClientState,
  client: CodexAppServerClient,
): boolean {
  for (const entry of state.clients.values()) {
    if (entry.client === client) {
      return true;
    }
  }
  return false;
}

function deleteSharedClientEntries(
  state: SharedCodexAppServerClientState,
  client: CodexAppServerClient,
): boolean {
  let deleted = false;
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      state.clients.delete(key);
      deleted = true;
    }
  }
  return deleted;
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
