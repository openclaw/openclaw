/** Shared client ownership, startup settlement, and terminal cleanup. */
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";

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
  startupAbort?: AbortController;
  onStartedClientCallbacks: Set<(client: CodexAppServerClient) => void>;
};

export type SharedCodexAppServerClientStartup = {
  initialized: Promise<void>;
  ready: Promise<CodexAppServerClient>;
};

export type CodexAppServerStartupLifetime = {
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  cleanups?: Map<CodexAppServerClient, StartupCleanupReceipt>;
};

type StartupCleanupReceipt = {
  operation: Promise<void>;
  unobserve: () => void;
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
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  nativeCommand?: string;
  desktopGeneration?: CodexDesktopGeneration;
};

export const createCodexAppServerStartupLifetime = (): CodexAppServerStartupLifetime => ({
  controller: new AbortController(),
  pending: new Set(),
  cleanups: new Map(),
});

function startupCleanupReceipts(lifetime: CodexAppServerStartupLifetime) {
  // Same-build reloads retain lifetime objects created before cleanup receipts were introduced.
  return (lifetime.cleanups ??= new Map<CodexAppServerClient, StartupCleanupReceipt>());
}

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

export function trackSharedCodexAppServerClient(client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  if (state.liveClients.has(client)) {
    return;
  }
  state.liveClients.add(client);
  client.addTransportExitHandler((exitedClient) => {
    state.liveClients.delete(exitedClient);
    for (const check of state.desktopGenerationDrainChecks) {
      check();
    }
  });
}

/** Failed startup retains custody until physical exit or a successful cleanup retry. */
export function closeCodexAppServerStartupClient(
  lifetime: CodexAppServerStartupLifetime,
  client: CodexAppServerClient,
  options?: Parameters<CodexAppServerClient["closeAndWait"]>[0],
): Promise<void> {
  const cleanups = startupCleanupReceipts(lifetime);
  const previous = cleanups.get(client);
  if (previous && lifetime.pending.has(previous.operation)) {
    return previous.operation;
  }
  previous?.unobserve();
  trackSharedCodexAppServerClient(client);
  getSharedCodexAppServerClientState().isolatedClients.delete(client);
  let exited = false;
  let awaitingExit = false;
  const unobserve = client.addTransportExitHandler(() => {
    exited = true;
    if (awaitingExit && cleanups.get(client)?.operation === closing) {
      cleanups.delete(client);
    }
  });
  const closing = ownCodexStartup(
    lifetime,
    (async () => {
      try {
        const result = await client.closeAndWait(options);
        if (!result.exited && !exited) {
          awaitingExit = true;
          throw new Error("Codex app-server startup cleanup did not confirm transport exit");
        }
      } finally {
        if (!awaitingExit) {
          unobserve();
        }
      }
    })(),
  );
  const receipt = { operation: closing, unobserve };
  cleanups.set(client, receipt);
  void closing.then(
    () => {
      if (cleanups.get(client) === receipt) {
        cleanups.delete(client);
      }
    },
    () => {},
  );
  return closing;
}

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

export function closeRetiredSharedClientEntryIfIdle(
  entry: SharedCodexAppServerClientEntry,
): boolean {
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
  if (!entry.client) {
    return;
  }
  closeRetiredSharedClientEntry(entry);
}

/** Failed final claimants join physical cleanup; healthy peers keep their startup. */
export async function waitForUnclaimedSharedClientStartup(
  entry: SharedCodexAppServerClientEntry,
  lifetime: CodexAppServerStartupLifetime,
): Promise<void> {
  if (!entry.startupTransport || entry.activeLeases > 0 || entry.pendingAcquires > 0) {
    return;
  }
  await entry.startupTransport.then(
    (client) => closeCodexAppServerStartupClient(lifetime, client),
    () => {},
  );
}

/** Clears all shared clients and waits for their processes to exit. */
export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const lifetime = state.startup;
  const cleanups = startupCleanupReceipts(lifetime);
  lifetime.controller.abort();
  state.clients.clear();
  const closing = new Map<CodexAppServerClient, Promise<void>>();
  const closeObservedClients = () => {
    for (const client of state.liveClients) {
      if (!closing.has(client)) {
        closing.set(client, closeCodexAppServerStartupClient(lifetime, client, options));
      }
    }
  };
  closeObservedClients();
  // Startup can add a late-registration close after its acquire is aborted.
  // Drain the producers as well as their published transports before reopening admission.
  try {
    while (lifetime.pending.size > 0) {
      await Promise.allSettled(lifetime.pending);
    }
    closeObservedClients();
    await Promise.allSettled(closing.values());
    const receipts = [...cleanups];
    const results = await Promise.allSettled(receipts.map(([, receipt]) => receipt.operation));
    // A callback failure remains reportable, but an observed exit has discharged physical custody.
    for (const [client, receipt] of receipts) {
      if (!state.liveClients.has(client) && cleanups.get(client) === receipt) {
        receipt.unobserve();
        cleanups.delete(client);
      }
    }
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      await nativeHookRelayUnregisterQueue.flush();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Codex app-server cleanup failed");
    }
  } finally {
    if (state.startup === lifetime && cleanups.size === 0) {
      state.startup = createCodexAppServerStartupLifetime();
    }
  }
}
