/** Client ownership and synchronous retirement, independent of startup/auth execution. */
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";

export type SharedCodexAppServerClientEntry = {
  /** Moves only through rekeySharedClientEntry. */
  key: string;
  client?: CodexAppServerClient;
  startup?: SharedCodexAppServerClientStartup;
  ready: boolean;
  activeLeases: number;
  // Anonymous releases cannot consume explicit native-subagent retains.
  anonymousLeases: number;
  pendingAcquires: number;
  closeWhenIdle: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasOwnedThreads?: () => boolean;
  onStartedClientCallbacks: Set<(client: CodexAppServerClient) => void>;
};

export type SharedCodexAppServerClientStartup = {
  initialized: Promise<void>;
  ready: Promise<CodexAppServerClient>;
};

export function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    entry = {
      key,
      ready: false,
      activeLeases: 0,
      anonymousLeases: 0,
      pendingAcquires: 0,
      closeWhenIdle: false,
      onStartedClientCallbacks: new Set(),
    };
    state.clients.set(key, entry);
  }
  return entry;
}

export class SharedCodexFallbackJoinError extends Error {
  readonly code = "CODEX_SHARED_FALLBACK_JOIN";

  constructor() {
    super("Shared Codex fallback already has a startup owner");
    this.name = "SharedCodexFallbackJoinError";
  }
}

export function isSharedCodexFallbackJoinError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "CODEX_SHARED_FALLBACK_JOIN";
}

/**
 * Moves a current entry to the fallback key. False means the caller must
 * re-acquire instead of starting a second client under an already-owned key.
 */
export function rekeySharedClientEntry(
  entry: SharedCodexAppServerClientEntry,
  key: string,
): boolean {
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(entry.key) !== entry) {
    return false;
  }
  const target = state.clients.get(key);
  if (target) {
    return target === entry;
  }
  state.clients.delete(entry.key);
  entry.key = key;
  state.clients.set(key, entry);
  return true;
}

export function closeSharedClientEntryIfUnclaimed(entry: SharedCodexAppServerClientEntry): boolean {
  if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(entry.key) !== entry) {
    return false;
  }
  state.clients.delete(entry.key);
  cancelSharedClientIdleRetirement(entry);
  entry.client?.close();
  return Boolean(entry.client);
}

export type CodexAppServerStartupLifetime = {
  controller: AbortController;
  pending: Set<Promise<unknown>>;
};

export type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
  liveClients: Set<CodexAppServerClient>;
  isolatedClients: Set<CodexAppServerClient>;
  entriesByClient: WeakMap<CodexAppServerClient, SharedCodexAppServerClientEntry>;
  startup: CodexAppServerStartupLifetime;
  startMetadata: WeakMap<CodexAppServerClient, CodexAppServerClientStartMetadata>;
};

type CodexAppServerClientStartMetadata = {
  transportExit?: Promise<void>;
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  nativeCommand?: string;
  desktopGeneration?: CodexDesktopGeneration;
};

export const createCodexAppServerStartupLifetime = (): CodexAppServerStartupLifetime => ({
  controller: new AbortController(),
  pending: new Set(),
});

export function ownCodexStartup<T>(
  lifetime: CodexAppServerStartupLifetime,
  operation: Promise<T>,
): Promise<T> {
  lifetime.pending.add(operation);
  const release = () => lifetime.pending.delete(operation);
  void operation.then(release, release);
  return operation;
}

// Share same-build module copies without adopting an older in-process plugin's clients.
export const getSharedCodexAppServerClientState = defineCodexBuildState(
  "openclaw.codexAppServerClientState",
  (): SharedCodexAppServerClientState => ({
    clients: new Map(),
    liveClients: new Set(),
    isolatedClients: new Set(),
    entriesByClient: new WeakMap(),
    startup: createCodexAppServerStartupLifetime(),
    startMetadata: new WeakMap(),
  }),
);

export function hasActiveSharedCodexAppServerWork(): boolean {
  const state = getSharedCodexAppServerClientState();
  if (state.startup.pending.size > 0 || state.startup.controller.signal.aborted) {
    return true;
  }
  for (const entry of state.clients.values()) {
    if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
      return true;
    }
  }
  for (const client of state.liveClients) {
    const entry = state.entriesByClient.get(client);
    if (entry && (entry.activeLeases > 0 || entry.pendingAcquires > 0)) {
      return true;
    }
  }
  return false;
}

export function getCurrentSharedClientEntry(
  client: CodexAppServerClient | undefined,
): SharedCodexAppServerClientEntry | undefined {
  const state = getSharedCodexAppServerClientState();
  const entry = client ? state.entriesByClient.get(client) : undefined;
  return entry && entry.client === client && state.clients.get(entry.key) === entry
    ? entry
    : undefined;
}

/**
 * Retires a matching shared client gracefully: detach from the map
 * (future acquisitions get a fresh client) and close once leases drain.
 */
export function retireSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): { activeLeases: number; closed: boolean } | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  const currentEntry = getCurrentSharedClientEntry(client);
  const entry = currentEntry ?? state.entriesByClient.get(client);
  if (!entry || entry.client !== client) {
    return undefined;
  }
  cancelSharedClientIdleRetirement(entry);
  if (currentEntry) {
    state.clients.delete(entry.key);
    entry.closeWhenIdle = true;
  }
  return {
    activeLeases: entry.activeLeases,
    closed: currentEntry ? closeRetiredSharedClientEntryIfIdle(entry) : false,
  };
}

/** Gracefully retires exact clients attached to an older desktop generation. */
export function retireSharedCodexAppServerClientsBeforeDesktopGeneration(
  generation: CodexDesktopGeneration,
): void {
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    const client = entry.client;
    const attached = client ? state.startMetadata.get(client) : undefined;
    if (
      client &&
      attached?.desktopGeneration &&
      attached.desktopGeneration.epoch < generation.epoch
    ) {
      retireSharedCodexAppServerClientIfCurrent(client);
    }
  }
}

function closeRetiredSharedClientEntryIfIdle(entry: SharedCodexAppServerClientEntry): boolean {
  if (
    !entry.closeWhenIdle ||
    entry.activeLeases > 0 ||
    entry.pendingAcquires > 0 ||
    !entry.client
  ) {
    return false;
  }
  entry.closeWhenIdle = false;
  return closeRetiredSharedClientEntry(entry);
}

function closeRetiredSharedClientEntry(entry: SharedCodexAppServerClientEntry): boolean {
  const client = entry.client;
  if (!client) {
    return false;
  }
  entry.client = undefined;
  cancelSharedClientIdleRetirement(entry);
  client.close();
  return true;
}

/** Exit registration also observes transports that have already terminated. */
export function waitForCodexAppServerClientExit(client: CodexAppServerClient): Promise<void> {
  const metadata = getSharedCodexAppServerClientState().startMetadata.get(client);
  const exited =
    metadata?.transportExit ??
    new Promise<void>((resolve) => {
      client.addTransportExitHandler(() => resolve());
    });
  if (metadata) {
    metadata.transportExit = exited;
  }
  return exited;
}

/** Acquire the recorded owner atomically, or join its exit before a replacement writes. */
export async function retainSharedCodexAppServerClientByInstanceId(
  clientId: string | undefined,
  options?: {
    signal?: AbortSignal;
    createAbortError?: (signal: AbortSignal) => Error;
    waitForExit?: boolean;
  },
) {
  const id = clientId?.trim();
  if (!id) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const client of state.liveClients) {
    if (client.getInstanceId() !== id) {
      continue;
    }
    const entry = state.entriesByClient.get(client);
    if (entry?.client !== client || client.getCloseError()) {
      // Stop must reach the parent while the transport owner finishes shutdown.
      // Replacement writers keep joining physical exit before acquiring ownership.
      if (options?.waitForExit === false && client.getCloseError()) {
        return undefined;
      }
      // Cancellation ends only this waiter; discovery still fences later writers.
      await racePromiseWithAbortSignal(
        waitForCodexAppServerClientExit(client),
        options?.signal,
        options?.createAbortError,
      );
      return undefined;
    }
    const release = retainSharedClientEntry(entry);
    return {
      client,
      // Only writer handoffs should wait for a still-usable retired owner.
      release: (waitForRetirement = false) => {
        release();
        return options?.waitForExit !== false &&
          (client.getCloseError() || (waitForRetirement && entry.closeWhenIdle))
          ? waitForCodexAppServerClientExit(client)
          : undefined;
      },
    };
  }
  return undefined;
}

// Keep minute-scale discovery and background work warm without retaining unused homes forever.
const CODEX_APP_SERVER_CLIENT_IDLE_GRACE_MS = 5 * 60_000;

function cancelSharedClientIdleRetirement(entry: SharedCodexAppServerClientEntry): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
}

export function refreshSharedClientIdleRetirement(client: CodexAppServerClient): void {
  const entry = getCurrentSharedClientEntry(client);
  if (entry) {
    scheduleSharedClientIdleRetirement(entry);
  }
}

function scheduleSharedClientIdleRetirement(entry: SharedCodexAppServerClientEntry): void {
  cancelSharedClientIdleRetirement(entry);
  if (
    !entry.ready ||
    entry.activeLeases > 0 ||
    entry.pendingAcquires > 0 ||
    !entry.client ||
    entry.hasOwnedThreads?.() ||
    getCurrentSharedClientEntry(entry.client) !== entry
  ) {
    return;
  }
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (entry.activeLeases === 0 && entry.pendingAcquires === 0 && !entry.hasOwnedThreads?.()) {
      retireSharedCodexAppServerClientIfCurrent(entry.client);
    }
  }, CODEX_APP_SERVER_CLIENT_IDLE_GRACE_MS);
  entry.idleTimer.unref?.();
}

export function retainSharedClientEntry(
  entry: SharedCodexAppServerClientEntry,
  counter: "activeLeases" | "pendingAcquires" = "activeLeases",
): () => void {
  let released = false;
  cancelSharedClientIdleRetirement(entry);
  entry[counter] += 1;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseSharedClientEntry(entry, counter);
  };
}

export function releaseSharedClientEntry(
  entry: SharedCodexAppServerClientEntry,
  counter: "activeLeases" | "pendingAcquires",
): void {
  entry[counter] -= 1;
  closeRetiredSharedClientEntryIfIdle(entry);
  scheduleSharedClientIdleRetirement(entry);
}
