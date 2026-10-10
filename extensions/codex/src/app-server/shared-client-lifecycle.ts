/** Client ownership and synchronous retirement, independent of startup/auth execution. */
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";

export type CodexAppServerAcquireBoundary =
  | "context"
  | "entry-selection"
  | "prestart-artifact-drain"
  | "transport-registration"
  | "initialize"
  | "catalog-observation"
  | "runtime-binding"
  | "auth-handoff"
  | "ready"
  | "cleanup";

export type CodexAppServerAcquireObservation = {
  boundary: CodexAppServerAcquireBoundary;
  startup?: "created-shared" | "joined-shared" | "ready-cache-hit" | "isolated";
};

type AcquireObserverOptions = {
  onAcquireObservation?: (observation: CodexAppServerAcquireObservation) => void;
};

export function observeAcquire(
  options: AcquireObserverOptions | undefined,
  observation: CodexAppServerAcquireObservation,
): void {
  try {
    options?.onAcquireObservation?.(observation);
  } catch {
    // Diagnostics do not own startup, cancellation, or a shared client's lifetime.
  }
}

export function observeSharedClientAcquire(
  entry: SharedCodexAppServerClientEntry,
  options: AcquireObserverOptions | undefined,
): () => void {
  const observer = (boundary: CodexAppServerAcquireBoundary) =>
    observeAcquire(options, { boundary });
  if (options?.onAcquireObservation) {
    (entry.acquireBoundaryObservers ??= new Set()).add(observer);
  }
  observeAcquire(options, {
    boundary: entry.acquireBoundary ?? "entry-selection",
    startup: entry.startup
      ? entry.acquireBoundary === "ready"
        ? "ready-cache-hit"
        : "joined-shared"
      : "created-shared",
  });
  return () => entry.acquireBoundaryObservers?.delete(observer);
}

export function recordSharedClientAcquireBoundary(
  entry: SharedCodexAppServerClientEntry,
  boundary: CodexAppServerAcquireBoundary,
): void {
  entry.acquireBoundary = boundary;
  for (const observer of entry.acquireBoundaryObservers ?? []) {
    observer(boundary);
  }
}

export type SharedCodexAppServerClientEntry = {
  readonly key: string;
  client?: CodexAppServerClient;
  startup?: SharedCodexAppServerClientStartup;
  startupTransport?: Promise<CodexAppServerClient>;
  activeLeases: number;
  // Anonymous releases cannot consume explicit native-subagent retains.
  anonymousLeases: number;
  pendingAcquires: number;
  closeWhenIdle: boolean;
  closeError?: Error;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasOwnedThreads?: () => boolean;
  startupAbort?: AbortController;
  onStartedClientCallbacks: Set<(client: CodexAppServerClient) => void>;
  acquireBoundary?: CodexAppServerAcquireBoundary;
  acquireBoundaryObservers?: Set<(boundary: CodexAppServerAcquireBoundary) => void>;
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
  desktopGenerationDrainChecks: Set<() => void>;
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
    desktopGenerationDrainChecks: new Set(),
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
 * Retires a matching shared client. Default is graceful: detach from the map
 * (future acquisitions get a fresh client) and close once leases drain.
 * `failActiveLeases` is for suspect clients only (timed-out turns): it closes
 * the physical connection immediately so co-leased attempts hit the normal
 * client-closed retry path, and pending acquires reject instead of leasing
 * the poisoned process. Routine cleanup must NOT use it — it would abort
 * healthy sibling turns on a working client.
 */
export function retireSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
  opts?: { failActiveLeases?: boolean },
): { activeLeases: number; closed: boolean } | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  const currentEntry = getCurrentSharedClientEntry(client);
  const entry = currentEntry ?? state.entriesByClient.get(client);
  if (!entry || (entry.client !== client && !entry.closeError)) {
    return undefined;
  }
  cancelSharedClientIdleRetirement(entry);
  if (currentEntry) {
    state.clients.delete(entry.key);
    entry.closeWhenIdle = true;
  }
  // Detached entries still own explicit native-subagent retains and remember
  // forced closure after the physical client has been cleared.
  if (opts?.failActiveLeases && (currentEntry || !entry.closeError)) {
    entry.closeError = new Error("codex app-server client is closed");
    return {
      activeLeases: entry.activeLeases,
      closed: closeRetiredSharedClientEntry(entry),
    };
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

export function retirePendingSharedClientEntryIfUnclaimed(
  entry: SharedCodexAppServerClientEntry,
): void {
  if (entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return;
  }
  entry.startupAbort?.abort(new Error("Codex app-server startup was abandoned"));
  entry.closeWhenIdle = true;
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(entry.key) === entry) {
    state.clients.delete(entry.key);
  }
  closeRetiredSharedClientEntry(entry);
}

/** Failed final claimants join physical cleanup; healthy peers keep their startup. */
export async function waitForUnclaimedSharedClientStartup(
  entry: SharedCodexAppServerClientEntry,
): Promise<void> {
  if (!entry.startupTransport || entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return;
  }
  await entry.startupTransport.then(
    (client) => client.closeAndWait(),
    () => {},
  );
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
export async function retainSharedCodexAppServerClientByInstanceId(clientId: string | undefined) {
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
    if (entry?.client !== client || entry.closeError || client.getCloseError()) {
      await waitForCodexAppServerClientExit(client);
      return undefined;
    }
    const release = retainSharedClientEntry(entry);
    return {
      client,
      // Only writer handoffs should wait for a still-usable retired owner.
      release: (waitForRetirement = false) => {
        release();
        return client.getCloseError() || (waitForRetirement && entry.closeWhenIdle)
          ? waitForCodexAppServerClientExit(client)
          : undefined;
      },
    };
  }
  return undefined;
}

export function notifyDesktopGenerationDrainChecks(state: SharedCodexAppServerClientState): void {
  for (const check of state.desktopGenerationDrainChecks) {
    check();
  }
}

// Cold initialization measured 1–5 seconds; keep adjacent discovery/status requests warm.
const CODEX_APP_SERVER_CLIENT_IDLE_GRACE_MS = 30_000;

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
  notifyDesktopGenerationDrainChecks(getSharedCodexAppServerClientState());
}
