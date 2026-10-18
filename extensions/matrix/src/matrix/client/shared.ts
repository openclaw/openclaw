import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { toStringifiedError as toRetirementError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { getMatrixRuntimeLifecycle, type MatrixRuntimeLifecycle } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { getMatrixMonitorTaskSignal } from "../monitor/task-runner.js";
import type { MatrixClient } from "../sdk.js";
import { awaitMatrixStartupWithAbort, throwIfMatrixStartupAborted } from "../startup-abort.js";
import { resolveMatrixAuth } from "./config.js";
import type { PreparedMatrixClientStorage } from "./create-client.js";
import type { MatrixAuth } from "./types.js";

const loadMatrixCreateClientDeps = createLazyRuntimeModule(() => import("./create-client.js"));
const MATRIX_RETIREMENT_DRAIN_TIMEOUT_MS = 5_000;

export type MatrixClientLeaseRole = "monitor" | "transient";
export type MatrixClientReleaseMode = "stop" | "persist" | "discard";

export type MatrixMonitorRetirement = {
  closeTaskAdmission: () => void;
  detachListeners: () => void;
  waitForTasks: () => Promise<void>;
  cleanup: () => Promise<void> | void;
};

export type SharedMatrixClientLease = {
  abortSignal: AbortSignal;
  client: MatrixClient;
  role: MatrixClientLeaseRole;
  registerMonitorRetirement: (retirement: MatrixMonitorRetirement) => void;
  start: (abortSignal?: AbortSignal) => Promise<void>;
  release: (params?: { mode?: MatrixClientReleaseMode }) => Promise<void>;
};

type SharedMatrixClientPhase = "open" | "retiring";

type SharedMatrixClientLeaseState = {
  abortController: AbortController;
  monitorRetirement: MatrixMonitorRetirement | null;
  monitorRetirementPromise: Promise<void> | null;
  role: MatrixClientLeaseRole;
  releasePromise: Promise<void> | null;
};

type SharedMatrixClientState = {
  client: MatrixClient;
  key: string;
  storageOwnerKey: string | null;
  started: boolean;
  startPromise: Promise<void> | null;
  phase: SharedMatrixClientPhase;
  leases: Set<SharedMatrixClientLeaseState>;
  monitorRetirementPromises: Set<Promise<void>>;
  noLeases: { promise: Promise<void>; resolve: () => void };
  retirementPromise: Promise<void> | null;
  poisonError: Error | null;
  releaseMode: MatrixClientReleaseMode;
  ownerSignal?: AbortSignal;
  detachLifecycle?: () => void;
};

type SharedMatrixClientParams = {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  auth?: MatrixAuth;
  startClient?: boolean;
  accountId?: string | null;
  abortSignal?: AbortSignal;
  role?: MatrixClientLeaseRole;
};

const sharedClientRegistry = resolveGlobalSingleton(
  Symbol.for("openclaw.matrix.shared-client-registry"),
  () => ({
    states: new Map<string, SharedMatrixClientState>(),
    promises: new Map<string, Promise<SharedMatrixClientState>>(),
    storageOwners: new Map<string, Promise<SharedMatrixClientState>>(),
  }),
);
const sharedClientStates = sharedClientRegistry.states;
const sharedClientPromises = sharedClientRegistry.promises;
const sharedStorageOwners = sharedClientRegistry.storageOwners;

class MatrixTransportGenerationBusyError extends Error {
  readonly code = "MATRIX_ACCOUNT_RESTARTING";
  readonly retryable = true;

  constructor() {
    super("Matrix account transport is changing; retry after the account restart finishes.");
  }
}

function buildSharedClientKey(auth: MatrixAuth): string {
  // Serialize the tuple as a whole: Matrix URLs and credentials may contain `|`,
  // so delimiter-joined keys can alias distinct clients and couple crypto/leases.
  return JSON.stringify([
    auth.homeserver,
    auth.userId,
    auth.accessToken,
    auth.encryption ? "e2ee" : "plain",
    auth.allowPrivateNetwork ? "private-net" : "strict-net",
    auth.dispatcherPolicy ?? null,
    auth.accountId,
  ]);
}

async function createSharedMatrixClient(params: {
  auth: MatrixAuth;
  timeoutMs?: number;
  lifecycle?: MatrixRuntimeLifecycle;
  preparedStorage: PreparedMatrixClientStorage;
}): Promise<SharedMatrixClientState> {
  const { createMatrixClient } = await loadMatrixCreateClientDeps();
  const client = await createMatrixClient(
    { ...params.auth, localTimeoutMs: params.timeoutMs },
    params.preparedStorage,
  );
  return {
    client,
    key: buildSharedClientKey(params.auth),
    storageOwnerKey: params.preparedStorage.storagePaths?.idbSnapshotPath ?? null,
    started: false,
    startPromise: null,
    phase: "open",
    leases: new Set(),
    monitorRetirementPromises: new Set(),
    noLeases: createDeferred<void>(),
    retirementPromise: null,
    poisonError: null,
    releaseMode: "discard",
    ownerSignal: params.lifecycle?.signal,
  };
}

function deleteSharedClientState(state: SharedMatrixClientState): void {
  if (sharedClientStates.get(state.key) === state) {
    sharedClientStates.delete(state.key);
    if (state.storageOwnerKey) {
      sharedStorageOwners.delete(state.storageOwnerKey);
    }
  }
  const detachLifecycle = state.detachLifecycle;
  state.detachLifecycle = undefined;
  detachLifecycle?.();
}

function bindSharedClientLifecycle(
  state: SharedMatrixClientState,
  lifecycle: MatrixRuntimeLifecycle | undefined,
): void {
  if (!lifecycle) {
    return;
  }
  state.detachLifecycle = lifecycle.onDispose(() => forceRetireState(state));
}

async function ensureSharedClientStarted(
  state: SharedMatrixClientState,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (state.started) {
    return;
  }
  if (state.startPromise) {
    await awaitMatrixStartupWithAbort(state.startPromise, abortSignal);
    return;
  }

  const startPromise = (async () => {
    await state.client.start({ abortSignal });
    throwIfMatrixStartupAborted(abortSignal);
    state.started = true;
  })();
  const guardedStart = startPromise.finally(() => {
    if (state.startPromise === guardedStart) {
      state.startPromise = null;
    }
  });
  state.startPromise = guardedStart;
  await awaitMatrixStartupWithAbort(guardedStart, abortSignal);
}

async function resolveSharedMatrixAuth(params: SharedMatrixClientParams): Promise<MatrixAuth> {
  const requestedAccountId = normalizeOptionalAccountId(params.accountId);
  if (params.auth && requestedAccountId && requestedAccountId !== params.auth.accountId) {
    throw new Error(
      `Matrix shared client account mismatch: requested ${requestedAccountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  if (params.auth) {
    return params.auth;
  }
  if (!params.cfg) {
    throw new Error(
      "Matrix shared client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  return resolveMatrixAuth({ cfg: params.cfg, env: params.env, accountId: params.accountId });
}

async function resolveOpenSharedMatrixClientState(
  params: SharedMatrixClientParams,
  lifecycle: MatrixRuntimeLifecycle | undefined,
): Promise<SharedMatrixClientState> {
  const auth = await resolveSharedMatrixAuth(params);
  throwIfMatrixStartupAborted(params.abortSignal);
  const key = buildSharedClientKey(auth);

  while (true) {
    const existing = sharedClientStates.get(key);
    if (existing?.poisonError) {
      throw existing.poisonError;
    }
    if (existing?.phase === "open" && existing.ownerSignal === lifecycle?.signal) {
      return existing;
    }
    if (existing?.retirementPromise) {
      await awaitMatrixStartupWithAbort(existing.retirementPromise, params.abortSignal);
      continue;
    }
    if (existing) {
      // Wait for the state cached in this module to drain and retire before
      // creating another client for the same auth key under a new owner.
      await awaitMatrixStartupWithAbort(existing.noLeases.promise, params.abortSignal);
      continue;
    }

    const pending = sharedClientPromises.get(key);
    if (pending) {
      await awaitMatrixStartupWithAbort(pending, params.abortSignal);
      continue;
    }

    const { prepareMatrixClientStorage } = await loadMatrixCreateClientDeps();
    const preparedStorage = await prepareMatrixClientStorage(auth);
    throwIfMatrixStartupAborted(params.abortSignal);
    // Preparation may choose an existing token-rotation alias. Admit that exact
    // store before creation writes metadata, opens sync state, or initializes crypto.
    if (sharedClientStates.has(key) || sharedClientPromises.has(key)) {
      continue;
    }
    const storageOwnerKey = preparedStorage.storagePaths?.idbSnapshotPath ?? null;
    const ownerPromise = storageOwnerKey ? sharedStorageOwners.get(storageOwnerKey) : undefined;
    if (ownerPromise) {
      const owner = await awaitMatrixStartupWithAbort(ownerPromise, params.abortSignal);
      if (owner.retirementPromise) {
        await awaitMatrixStartupWithAbort(owner.retirementPromise, params.abortSignal);
        continue;
      }
      throw new MatrixTransportGenerationBusyError();
    }

    const creationPromise = createSharedMatrixClient({
      auth,
      timeoutMs: params.timeoutMs,
      lifecycle,
      preparedStorage,
    });
    sharedClientPromises.set(key, creationPromise);
    if (storageOwnerKey) {
      sharedStorageOwners.set(storageOwnerKey, creationPromise);
    }
    try {
      const created = await creationPromise;
      sharedClientStates.set(key, created);
      try {
        bindSharedClientLifecycle(created, lifecycle);
      } catch (error) {
        await forceRetireState(created);
        throw error;
      }
      return created;
    } finally {
      if (sharedClientPromises.get(key) === creationPromise) {
        sharedClientPromises.delete(key);
      }
      if (
        storageOwnerKey &&
        !sharedClientStates.has(key) &&
        sharedStorageOwners.get(storageOwnerKey) === creationPromise
      ) {
        sharedStorageOwners.delete(storageOwnerKey);
      }
    }
  }
}

async function runMonitorRetirement(
  retirement: MatrixMonitorRetirement | undefined,
): Promise<void> {
  if (!retirement) {
    return;
  }
  retirement.closeTaskAdmission();
  retirement.detachListeners();
  await retirement.waitForTasks();
  await retirement.cleanup();
}

function retireMonitorLease(
  state: SharedMatrixClientState,
  lease: SharedMatrixClientLeaseState,
): Promise<void> {
  if (lease.monitorRetirementPromise) {
    return lease.monitorRetirementPromise;
  }
  lease.monitorRetirementPromise = runMonitorRetirement(lease.monitorRetirement ?? undefined);
  state.monitorRetirementPromises.add(lease.monitorRetirementPromise);
  return lease.monitorRetirementPromise;
}

async function retireMonitorLeases(
  state: SharedMatrixClientState,
  leases: SharedMatrixClientLeaseState[],
): Promise<void> {
  for (const lease of leases) {
    void retireMonitorLease(state, lease);
  }
  const results = await Promise.allSettled(state.monitorRetirementPromises);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}

function mergeReleaseMode(
  current: MatrixClientReleaseMode,
  requested: MatrixClientReleaseMode,
): MatrixClientReleaseMode {
  // Release requirements belong to the generation; one lease cannot weaken another's durability.
  if (current === "persist" || requested === "persist") {
    return "persist";
  }
  if (current === "stop" || requested === "stop") {
    return "stop";
  }
  return "discard";
}

function abortTransientLeases(state: SharedMatrixClientState): void {
  for (const lease of state.leases) {
    if (lease.role === "transient") {
      lease.abortController.abort();
    }
  }
}

function forceReleaseLeases(state: SharedMatrixClientState, releasePromise: Promise<void>): void {
  for (const lease of state.leases) {
    // Only monitor owners join shutdown; their transient child tasks must be able to drain.
    lease.releasePromise ??= lease.role === "monitor" ? releasePromise : Promise.resolve();
    lease.abortController.abort();
  }
  state.leases.clear();
  state.noLeases.resolve();
}

function waitForRetirement(retirement: Promise<void>): Promise<void> {
  return raceWithTimeout(
    retirement,
    MATRIX_RETIREMENT_DRAIN_TIMEOUT_MS,
    () => {
      throw new Error("Matrix client retirement did not settle within 5000ms");
    },
    { ref: false },
  );
}

function beginGenerationRetirement(params: {
  state: SharedMatrixClientState;
  monitorLeases?: SharedMatrixClientLeaseState[];
}): Promise<void> {
  const { state } = params;
  if (state.retirementPromise) {
    return waitForRetirement(state.retirementPromise);
  }
  state.phase = "retiring";
  if (state.leases.size === 0) {
    state.noLeases.resolve();
  }
  const result = createDeferred<void>();
  state.retirementPromise = result.promise;
  const owner = Promise.resolve().then(async () => {
    // Timeout bounds the caller, not SDK ownership. A replacement still waits for
    // this one shutdown to finish; there is no separate late-drain recovery path.
    await state.startPromise?.catch(() => undefined);
    try {
      await state.client.quiesceSync();
      state.started = false;
      await state.client.drainPendingDecryptions("matrix monitor sync quiesce");
    } catch (error) {
      state.poisonError = toRetirementError(error);
    }
    try {
      await retireMonitorLeases(state, params.monitorLeases ?? []);
    } catch (error) {
      state.poisonError ??= toRetirementError(error);
    }
    await state.noLeases.promise;
    if (state.poisonError) {
      // A failed first drain may still have crypto writes in flight. Rejoin them
      // before discard; successful quiescence already blocked every producer.
      await state.client
        .drainPendingDecryptions("matrix failed shutdown")
        .catch((error: unknown) => {
          state.poisonError = toRetirementError(error);
        });
    }
    let failure = state.poisonError;
    let discard = failure !== null || state.releaseMode === "discard";
    if (!discard) {
      try {
        await state.client.stopAndPersist();
      } catch (error) {
        discard = true;
        if (state.releaseMode === "persist") {
          failure = state.poisonError = toRetirementError(error);
        }
      }
    }
    if (discard) {
      await state.client.stopWithoutPersist();
    }
    deleteSharedClientState(state);
    if (failure) {
      throw failure;
    }
  });
  void owner.then(result.resolve, (error: unknown) => {
    state.poisonError = toRetirementError(error);
    result.reject(state.poisonError);
  });
  abortTransientLeases(state);
  return waitForRetirement(state.retirementPromise);
}

function createSharedMatrixClientLease(
  state: SharedMatrixClientState,
  role: MatrixClientLeaseRole,
): SharedMatrixClientLease {
  if (state.phase !== "open" || state.poisonError) {
    throw new Error("Matrix client is retiring; retry the operation after shutdown");
  }
  const leaseState: SharedMatrixClientLeaseState = {
    abortController: new AbortController(),
    monitorRetirement: null,
    monitorRetirementPromise: null,
    role,
    releasePromise: null,
  };
  state.leases.add(leaseState);

  return {
    abortSignal: leaseState.abortController.signal,
    client: state.client,
    role,
    registerMonitorRetirement: (retirement) => {
      leaseState.monitorRetirement = retirement;
    },
    start: async (abortSignal) => {
      if (leaseState.releasePromise) {
        throw new Error("Matrix client lease has already been released");
      }
      if (state.phase !== "open") {
        throw new Error("Matrix client generation is retiring");
      }
      const startupSignal = abortSignal
        ? AbortSignal.any([abortSignal, leaseState.abortController.signal])
        : leaseState.abortController.signal;
      await ensureSharedClientStarted(state, startupSignal);
    },
    release: (releaseParams = {}) => {
      if (leaseState.releasePromise) {
        return leaseState.releasePromise;
      }
      state.releaseMode = mergeReleaseMode(state.releaseMode, releaseParams.mode ?? "stop");
      state.leases.delete(leaseState);
      if (state.leases.size === 0) {
        state.noLeases.resolve();
      }

      const finalMonitor =
        role === "monitor" && !Array.from(state.leases).some((lease) => lease.role === "monitor");
      if (role === "monitor" && !finalMonitor) {
        leaseState.releasePromise = retireMonitorLease(state, leaseState);
        return leaseState.releasePromise;
      }
      // Retirement drains monitor tasks, which can themselves release transient leases.
      // Those child releases must not wait for the enclosing generation to finish.
      const shouldRetire = state.phase === "open" && (finalMonitor || state.leases.size === 0);
      if (!shouldRetire) {
        leaseState.releasePromise = state.poisonError
          ? Promise.reject(state.poisonError)
          : Promise.resolve();
        return leaseState.releasePromise;
      }
      leaseState.releasePromise = beginGenerationRetirement({
        state,
        monitorLeases: role === "monitor" ? [leaseState] : undefined,
      });
      return leaseState.releasePromise;
    },
  };
}

export async function acquireSharedMatrixClient(
  params: SharedMatrixClientParams = {},
): Promise<SharedMatrixClientLease> {
  const lifecycle = getMatrixRuntimeLifecycle();
  const signals = [getMatrixMonitorTaskSignal(), params.abortSignal, lifecycle?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const abortSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const acquisition = { ...params, abortSignal };
  throwIfMatrixStartupAborted(abortSignal);
  const state = await resolveOpenSharedMatrixClientState(acquisition, lifecycle);
  if (abortSignal?.aborted) {
    // An awaited creation can outlive its caller; retire an unclaimed client before rejecting.
    if (state.phase === "open" && state.leases.size === 0) {
      await beginGenerationRetirement({ state });
    }
    throwIfMatrixStartupAborted(abortSignal);
  }
  const lease = createSharedMatrixClientLease(state, params.role ?? "transient");
  if (params.startClient !== false) {
    try {
      await lease.start(abortSignal);
    } catch (error) {
      await lease.release({ mode: "stop" }).catch(() => undefined);
      throw error;
    }
  }
  return lease;
}

async function forceRetireState(state: SharedMatrixClientState): Promise<void> {
  state.releaseMode = mergeReleaseMode(state.releaseMode, "stop");
  const retirementPromise = beginGenerationRetirement({
    state,
    monitorLeases: Array.from(state.leases).filter((lease) => lease.role === "monitor"),
  });
  forceReleaseLeases(state, retirementPromise);
  await retirementPromise;
}

export async function stopSharedClientForAccount(auth: MatrixAuth): Promise<void> {
  const state = sharedClientStates.get(buildSharedClientKey(auth));
  if (!state || state.ownerSignal !== getMatrixRuntimeLifecycle()?.signal) {
    return;
  }
  await forceRetireState(state);
}
