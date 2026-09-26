import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeAgentRunApprovalWait } from "./agent-run-approval-wait.js";
import { raceWithAbortSignal } from "./agent-tools.abort.js";
import { runBridgeRequest } from "./code-mode-bridge.js";
import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeWorkerResult,
} from "./code-mode-executor-types.js";
import type { CodeModeOutputState } from "./code-mode-json.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { CodeModeProgramDataInbox, type CodeModeReplyLease } from "./code-mode-program-data.js";
import { createCodeModeResultsAccess, type CodeModeResultsAccess } from "./code-mode-results.js";
import type {
  CodeModeConfig,
  CodeModeSettlementMode,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-runtime.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

export type CodeModeBridgeDispatchState = {
  started: boolean;
};

export type PendingBridgeState = PendingBridgeRequest & {
  promise: Promise<void>;
  reply: CodeModeReplyLease;
  settled?: boolean;
  settledSequence?: number;
  cancel?: () => void;
};

type CodeModeRunState = {
  runId: string;
  replayId: string;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  continuation: CodeModeExecutorContinuation;
  pending: PendingBridgeState[];
  settlementMode: CodeModeSettlementMode;
  // True only when every future bridge call is enforced read-only before execution.
  replaySafe: boolean;
  output: CodeModeOutputState;
  expiresAt: number;
  agentWaitRetainUntil?: number;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  bridgeDispatch: CodeModeBridgeDispatchState;
  owner: CodeModeRunOwner;
};

export type CodeModeRunOwner = ReturnType<typeof createCodeModeRunOwner>;

const MAX_ACTIVE_CODE_MODE_RUNS = 64;
const MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS = 4;
const BRIDGE_CLOSED_MESSAGE = "Code Mode tool canceled, expired, or owner lost; start a new run.";
const log = createSubsystemLogger("agents/code-mode");

export const activeRuns = new Map<string, CodeModeRunState>();
export const resumingRunIds = new Set<string>();
const liveRunOwners = new Set<CodeModeRunOwner>();
let activeRunReservations = 0;
let nextPendingBridgeSettlementSequence = 0;
let activeRunExpiryTimer: ReturnType<typeof setTimeout> | undefined;

/** Catalog ownership spans worker legs and continuations; parking never closes the cell. */
export function createCodeModeRunOwner(ctx: ToolSearchToolContext, config: CodeModeConfig) {
  const inbox = new CodeModeProgramDataInbox(config);
  // A parked cell still owns pending calls and their output. Re-admission waits
  // for its final exec/wait result rather than stranding or replaying that work.
  const releaseRuntimeRefresh = captureAgentPluginRuntimeRefresh().hold();
  const runId = `cm_${randomUUID()}`;
  const closed = new AbortController();
  // Observe approvals for the entire cell, including parked gaps.
  const approvalWait = observeAgentRunApprovalWait(ctx);
  const signal = ctx.abortSignal
    ? AbortSignal.any([closed.signal, ctx.abortSignal])
    : closed.signal;
  const disposers = ctx.catalogRef
    ? (ctx.catalogRef.onDispose ??= new Set<() => void>())
    : undefined;
  let releaseCall = () => {};
  let continuation: CodeModeExecutorContinuation | undefined;
  let closing: Promise<void> | undefined;
  const executions = new Set<Promise<CodeModeWorkerResult>>();
  const disposals = new Map<CodeModeExecutorContinuation, Promise<void>>();
  const cleanupFailures = new Map<CodeModeExecutorContinuation, unknown>();
  const disposeContinuation = (value: CodeModeExecutorContinuation): Promise<void> => {
    const current = disposals.get(value);
    if (current) {
      return current;
    }
    const disposal = Promise.resolve().then(() => value.dispose());
    disposals.set(value, disposal);
    void disposal.then(
      () => {
        disposals.delete(value);
        cleanupFailures.delete(value);
      },
      (error: unknown) => {
        cleanupFailures.set(value, error);
        disposals.delete(value);
      },
    );
    return disposal;
  };
  const retainContinuation = async (next?: CodeModeExecutorContinuation): Promise<void> => {
    const previous = continuation;
    continuation = signal.aborted ? undefined : next;
    const retired: Promise<void>[] = [];
    if (previous && previous !== continuation) {
      retired.push(disposeContinuation(previous));
    }
    if (signal.aborted && next && next !== previous) {
      retired.push(disposeContinuation(next));
    }
    const results = await Promise.allSettled(retired);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Code Mode continuation cleanup failed");
    }
  };
  const close = (reason?: unknown): Promise<void> => {
    if (closing) {
      return closing;
    }
    const completion = createDeferredCore();
    closing = completion.promise;
    // Event callbacks cannot await close; keep failures visible and owned for shutdown.
    void closing.catch((error: unknown) => {
      log.error("Code Mode cleanup failed", {
        runId,
        error: formatErrorMessage(error),
        failures: [...cleanupFailures.values()].map(formatErrorMessage),
      });
    });
    if (!closed.signal.aborted) {
      releaseCall();
      approvalWait.dispose();
      signal.removeEventListener("abort", onLifetimeAbort);
      disposers?.delete(onCatalogDispose);
      closed.abort(reason);
      inbox.close();
      const parked = activeRuns.get(runId);
      if (parked?.owner === owner) {
        activeRuns.delete(runId);
        cancelPendingBridgeStates(parked.pending);
      }
      scheduleActiveRunExpiry();
    }
    // Retry only already failed resources; a failure in this attempt stays owned for the next close.
    for (const failed of cleanupFailures.keys()) {
      void disposeContinuation(failed);
    }
    const retained = continuation;
    continuation = undefined;
    if (retained) {
      void disposeContinuation(retained);
    }
    void Promise.resolve()
      .then(async () => {
        // Abort revokes dispatch immediately, but a worker can return its parked handle later.
        await Promise.allSettled(executions);
        while (disposals.size) {
          await Promise.allSettled(disposals.values());
        }
        if (cleanupFailures.size) {
          throw new PluginRuntimeCloseRetainedError(
            new AggregateError(cleanupFailures.values(), "Code Mode continuation cleanup failed"),
          );
        }
        releaseRuntimeRefresh();
        liveRunOwners.delete(owner);
      })
      .then(completion.resolve, (error: unknown) => {
        closing = undefined;
        completion.reject(error);
      });
    return closing;
  };
  const onLifetimeAbort = () => {
    void close(signal.reason);
  };
  const onCatalogDispose = () => {
    void close();
  };
  const owner = {
    runId,
    signal,
    inbox,
    results: createCodeModeResultsAccess(ctx, config),
    close,
    retainContinuation,
    runExecution(operation: () => Promise<CodeModeWorkerResult>): Promise<CodeModeWorkerResult> {
      const execution = Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation();
        })
        .then(async (result) => {
          await retainContinuation(result.status === "waiting" ? result.continuation : undefined);
          return result;
        });
      executions.add(execution);
      void execution.then(
        () => executions.delete(execution),
        () => executions.delete(execution),
      );
      return execution;
    },
    approvalWait,
    bindCall(callSignal?: AbortSignal): AbortSignal {
      releaseCall();
      if (signal.aborted) {
        return signal;
      }
      const combined = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
      const release = () => combined.removeEventListener("abort", onAbort);
      const onAbort = () => {
        // A completed observer cannot cancel a later wait on this same cell.
        if (releaseCall === release) {
          void close(combined.reason);
        }
      };
      releaseCall = release;
      combined.addEventListener("abort", onAbort, { once: true });
      if (combined.aborted) {
        onAbort();
      }
      // Pending work follows the cell, not an observer replaced by a later wait.
      return signal;
    },
  };
  liveRunOwners.add(owner);
  disposers?.add(onCatalogDispose);
  signal.addEventListener("abort", onLifetimeAbort, { once: true });
  if (!ctx.catalogRef?.current || signal.aborted) {
    void close(signal.reason);
  }
  return owner;
}

export function createCodeModeBridgeDispatchState(): CodeModeBridgeDispatchState {
  return { started: false };
}

// One unreferenced timer owns parked continuations even when no later exec or wait
// arrives; otherwise expired runs keep their VM bytes and live tool calls.
function scheduleActiveRunExpiry(): void {
  if (activeRunExpiryTimer) {
    clearTimeout(activeRunExpiryTimer);
    activeRunExpiryTimer = undefined;
  }
  let nextExpiresAt = Number.POSITIVE_INFINITY;
  for (const state of activeRuns.values()) {
    nextExpiresAt = Math.min(nextExpiresAt, state.expiresAt);
  }
  if (!Number.isFinite(nextExpiresAt)) {
    return;
  }
  activeRunExpiryTimer = setTimeout(
    () => {
      activeRunExpiryTimer = undefined;
      removeExpiredRuns();
      scheduleActiveRunExpiry();
    },
    Math.max(1, nextExpiresAt - Date.now()),
  );
  activeRunExpiryTimer.unref?.();
}

export function removeExpiredRuns(now = Date.now()): void {
  for (const [runId, state] of activeRuns) {
    if (!isFutureDateTimestampMs(state.expiresAt, { nowMs: now })) {
      // Parked collectors extend idle TTL, bounded so a lost terminal event cannot pin all slots.
      if (
        state.pending?.some((entry) => entry.method === "agentWait" && !entry.settled) &&
        state.agentWaitRetainUntil !== undefined &&
        isFutureDateTimestampMs(state.agentWaitRetainUntil, { nowMs: now })
      ) {
        const renewed = resolveCodeModeSnapshotExpiresAt(now, state.config.snapshotTtlSeconds);
        if (renewed !== undefined) {
          state.expiresAt = Math.min(renewed, state.agentWaitRetainUntil);
          continue;
        }
      }
      disposeCodeModeRun(runId);
    }
  }
}

function disposeCodeModeRun(runId: string): void {
  const state = activeRuns.get(runId);
  activeRuns.delete(runId);
  void state?.owner.close();
  cancelPendingBridgeStates(state?.pending ?? []);
  resumingRunIds.delete(runId);
  scheduleActiveRunExpiry();
}

/** Cancel every cell before its Gateway-owned runtimes disappear. */
export async function disposeAllCodeModeRuns(): Promise<void> {
  const closing = [...liveRunOwners].map((owner) => owner.close());
  activeRuns.clear();
  resumingRunIds.clear();
  scheduleActiveRunExpiry();
  const results = await Promise.allSettled(closing);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Code Mode runs failed to close");
  }
}

/** Abort each bridge call whose result has not already reached its guest. */
export function cancelPendingBridgeStates(pending: readonly PendingBridgeState[]): void {
  for (const entry of pending) {
    if (entry.settled) {
      entry.reply.release();
    } else {
      entry.cancel?.();
    }
  }
}

/** Apply restored-guest cancellation to the parent-owned host operations. */
export function cancelPendingBridgeStatesById(
  pending: PendingBridgeState[],
  canceledRequestIds: readonly string[],
): void {
  if (canceledRequestIds.length === 0) {
    return;
  }
  const canceled = new Set(canceledRequestIds);
  const discarded = pending.filter((entry) => canceled.has(entry.id));
  cancelPendingBridgeStates(discarded);
  // The guest removed these requests; no cancellation reply will be delivered.
  // Keep ordinary cancellation catchable, but release guest-discarded leases now.
  for (const entry of discarded) {
    entry.reply.release();
  }
  pending.splice(0, pending.length, ...pending.filter((entry) => !canceled.has(entry.id)));
}

/** Deliver bridge responses in actual settlement order, not request order. */
export function takeSettledBridgeRequests(pending: readonly PendingBridgeState[]) {
  const leases = pending
    .filter((entry) => entry.settled)
    .toSorted((left, right) => (left.settledSequence ?? 0) - (right.settledSequence ?? 0))
    .map((entry) => entry.reply);
  const requests: SettledBridgeRequest[] = [];
  const release = () => {
    for (const lease of leases) {
      lease.release();
    }
    leases.length = 0;
    requests.length = 0;
  };
  try {
    for (const lease of leases) {
      requests.push(lease.take());
    }
    return { requests, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Keep every dispatched bridge call required until its guest has received the result. */
export function pendingBridgeStatesForSettlement(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
): readonly PendingBridgeState[] {
  if (settlementMode.kind === "awaiting") {
    return pending;
  }
  const requiredRequestIds = new Set(settlementMode.requiredRequestIds);
  return pending.filter((entry) => requiredRequestIds.has(entry.id));
}

/** Await the shared guest frontier without guessing native Promise ownership. */
export function waitForPendingBridgeSettlement(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
): Promise<void> {
  const required = pendingBridgeStatesForSettlement(pending, settlementMode);
  const outstanding = required.filter((entry) => !entry.settled);
  // Workers reject hostless pending guests; headless execution also validates
  // the frontier before reaching this shared settlement helper.
  if (
    outstanding.length === 0 ||
    (settlementMode.kind === "awaiting" && outstanding.length !== required.length)
  ) {
    return Promise.resolve();
  }
  const settlement =
    settlementMode.kind === "draining"
      ? Promise.all(outstanding.map((entry) => entry.promise))
      : Promise.race(outstanding.map((entry) => entry.promise));
  return settlement.then(() => undefined);
}

function resolveCodeModeSnapshotExpiresAt(now: number, ttlSeconds: number): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(ttlSeconds, { nowMs: now });
}

function enforceActiveRunLimit(): void {
  removeExpiredRuns();
  if (activeRuns.size + activeRunReservations >= MAX_ACTIVE_CODE_MODE_RUNS) {
    throw new ToolInputError("too many suspended code mode runs.");
  }
}

export function reserveActiveRunSlot(ownedRunId?: string): () => void {
  if (ownedRunId === undefined) {
    enforceActiveRunLimit();
  } else {
    const state = activeRuns.get(ownedRunId);
    if (!state) {
      throw new ToolInputError("code mode run is unavailable or expired.");
    }
    activeRuns.delete(ownedRunId);
    scheduleActiveRunExpiry();
  }
  // Resume transfers an existing slot without exposing a free capacity window
  // to concurrent exec calls or rejecting its own run at the global limit.
  activeRunReservations += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeRunReservations = Math.max(0, activeRunReservations - 1);
  };
}

export function pendingBridgeRequestsReplaySafe(
  pending: readonly PendingBridgeRequest[],
  runtime: ToolSearchRuntime,
  catalogProjection: CodeModeCatalogProjection,
): boolean {
  return pending.every((request) =>
    isPendingBridgeRequestReplaySafe(request, runtime, catalogProjection),
  );
}

function isPendingBridgeRequestReplaySafe(
  request: PendingBridgeRequest,
  runtime: ToolSearchRuntime,
  catalogProjection: CodeModeCatalogProjection,
): boolean {
  if (
    request.method === "search" ||
    request.method === "describe" ||
    request.method === "yield" ||
    request.method === "agentSpawn" ||
    request.method === "agentWait" ||
    request.method === "skillsList" ||
    request.method === "skillsRead" ||
    request.method === "sleep"
  ) {
    return true;
  }
  if (request.method === "nodes") {
    return request.args[0] === "list" || request.args[0] === "get";
  }
  // Saved references are transient, and deletion cannot be replayed safely.
  // Result operations intentionally stay outside restart-safe execution.
  if (request.method !== "callValue") {
    return false;
  }
  const callableName = Array.isArray(request.args) ? request.args[0] : undefined;
  if (typeof callableName !== "string") {
    return false;
  }
  const binding = catalogProjection.byCallableName.get(callableName);
  return binding ? runtime.isReplaySafeExactId(binding.id) : false;
}

export function createPendingBridgeStates(
  pendingRequests: PendingBridgeRequest[],
  params: {
    config: CodeModeConfig;
    inbox: CodeModeProgramDataInbox;
    results: CodeModeResultsAccess;
    runtime: ToolSearchRuntime;
    catalogProjection: CodeModeCatalogProjection;
    namespaceRuntime: CodeModeNamespaceRuntime;
    parentToolCallId: string;
    codeModeRunId: string;
    remainingMs: number;
    activeRunId?: string;
    ctx: ToolSearchToolContext;
    signal: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
    bridgeDispatch: CodeModeBridgeDispatchState;
  },
): PendingBridgeState[] {
  // Pending siblings retain dispatch context, never the original request batch.
  return pendingRequests.map((request) => {
    // Bridge calls start while the guest is parked. The wait tool delivers
    // settled values to the same continuation without replaying host actions.
    const reply = params.inbox.createReply(request.id);
    const abortController = new AbortController();
    const signal = abortController.signal;
    // Relay only while pending: closing a finished cell must not cancel an
    // external operation whose result was already delivered to its guest.
    const onAbort = () => {
      reply.cancel();
      abortController.abort(params.signal.reason);
    };
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) {
      onAbort();
    }
    if (request.method !== "sleep") {
      params.bridgeDispatch.started = true;
    }
    const bridgeCall = runBridgeRequest({
      runtime: params.runtime,
      results: params.results,
      catalogProjection: params.catalogProjection,
      namespaceRuntime: params.namespaceRuntime,
      parentToolCallId: params.parentToolCallId,
      codeModeRunId: params.codeModeRunId,
      reply,
      remainingMs: Math.max(1, params.remainingMs),
      ctx: params.ctx,
      request,
      signal,
      onUpdate: params.onUpdate,
    });
    const completion = raceWithAbortSignal(bridgeCall, signal).catch(() => {
      // Canceled leases are fenced; this cannot retain an arbitrary abort reason.
      reply.settle(false, BRIDGE_CLOSED_MESSAGE);
    });
    const state: PendingBridgeState = {
      ...request,
      reply,
      promise: completion.then(() => {
        params.signal.removeEventListener("abort", onAbort);
        state.settledSequence = ++nextPendingBridgeSettlementSequence;
        state.settled = true;
        // Only the response is needed until guest replay; live calls keep their own request.
        state.args = [];
        if (state.method === "agentWait" && params.activeRunId) {
          const active = activeRuns.get(params.activeRunId);
          if (active?.pending.includes(state)) {
            const renewed = resolveCodeModeSnapshotExpiresAt(
              Date.now(),
              active.config.snapshotTtlSeconds,
            );
            if (renewed !== undefined) {
              active.expiresAt = renewed;
              scheduleActiveRunExpiry();
            }
          }
        }
      }),
      cancel: () => {
        reply.cancel();
        if (!state.settled) {
          abortController.abort(new Error(BRIDGE_CLOSED_MESSAGE));
        }
      },
    };
    return state;
  });
}

export function storeSuspendedRun(params: {
  owner: CodeModeRunOwner;
  replayId: string;
  pending: PendingBridgeState[];
  replaySafe: boolean;
  settlementMode: CodeModeSettlementMode;
  continuation: CodeModeExecutorContinuation;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: CodeModeOutputState;
  bridgeDispatch: CodeModeBridgeDispatchState;
}) {
  const runId = params.owner.runId;
  if (params.owner.signal.aborted) {
    cancelPendingBridgeStates(params.pending);
    return codeModeAbortedResult(params);
  }
  const now = Date.now();
  const expiresAt = resolveCodeModeSnapshotExpiresAt(now, params.config.snapshotTtlSeconds);
  if (expiresAt === undefined) {
    throw new ToolInputError("code mode run expiry is unavailable.");
  }
  const hasPendingAgentWait = params.pending.some(
    (entry) => entry.method === "agentWait" && !entry.settled,
  );
  const agentWaitRetainUntil = hasPendingAgentWait
    ? resolveCodeModeSnapshotExpiresAt(
        now,
        params.config.snapshotTtlSeconds * MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS,
      )
    : undefined;
  const state: CodeModeRunState = {
    runId,
    replayId: params.replayId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    config: params.config,
    continuation: params.continuation,
    pending: params.pending,
    settlementMode: params.settlementMode,
    replaySafe: params.replaySafe,
    output: params.output,
    expiresAt,
    agentWaitRetainUntil,
    runtime: params.runtime,
    catalogProjection: params.catalogProjection,
    namespaceRuntime: params.namespaceRuntime,
    bridgeDispatch: params.bridgeDispatch,
    owner: params.owner,
  };
  const result = params.output.takeResult(
    {
      status: "waiting" as const,
      runId,
      reason: codeModeWaitingReason(params.pending),
      pendingToolCalls: pendingToolCalls(params.pending),
      replaySafe: params.replaySafe,
      telemetry: telemetry(params.runtime),
    },
    {},
    params.runtime.hasNetworkContent(),
  );
  // A result that cannot expose its continuation must not leave an unreachable parked cell.
  activeRuns.set(runId, state);
  scheduleActiveRunExpiry();
  return result;
}

export function codeModeAbortedResult(params: {
  bridgeDispatch: CodeModeBridgeDispatchState;
  output: CodeModeOutputState;
  replaySafe: boolean;
  runtime: ToolSearchRuntime;
}) {
  return params.output.takeResult(
    {
      status: "failed" as const,
      code: "aborted" as const,
      failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("host" as const),
      bridgeDispatchStarted: params.bridgeDispatch.started,
      replaySafe: params.replaySafe,
      telemetry: telemetry(params.runtime),
    },
    { error: "code mode execution aborted" },
    params.runtime.hasNetworkContent(),
  );
}

function codeModeWaitingReason(pending: readonly PendingBridgeState[]): "pending_tools" | "yield" {
  return pending.length > 0 && pending.every((entry) => entry.method === "yield")
    ? "yield"
    : "pending_tools";
}

function pendingToolCalls(pending: readonly PendingBridgeState[]) {
  // Settled calls remain in continuations until the guest consumes their response,
  // but they must not be advertised as outstanding work to exec or wait.
  return pending
    .filter((entry) => !entry.settled)
    .map((entry) => ({ id: entry.id, method: entry.method }));
}

export function telemetry(runtime: ToolSearchRuntime) {
  return {
    ...runtime.telemetry(),
    visibleTools: [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME],
  };
}
