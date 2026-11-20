import { setImmediate as yieldToScheduler } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { codeModeGcAttribution, logCodeModeFailure } from "../logging/code-mode-diagnostic.js";
import { requiresCodeModeCompletion } from "./code-mode-bridge.js";
import { isCodeModePendingReady, waitForCodeModePending } from "./code-mode-execution-budget.js";
import type { CodeModeSettlementContext } from "./code-mode-execution.js";
import type { CodeModeExecutorInlineHost } from "./code-mode-executor-types.js";
import { codeModeFailureMessage, type PendingBridgeRequest } from "./code-mode-runtime.js";
import {
  cancelPendingBridgeStatesById,
  createPendingBridgeStates,
  takeSettledBridgeRequests,
  type PendingBridgeState,
} from "./code-mode-state.js";

export async function dispatchCodeModeRequests(
  params: Omit<CodeModeSettlementContext, "result">,
  pending: PendingBridgeState[],
  requests: PendingBridgeRequest[],
): Promise<void> {
  await params.owner.durable?.prepare(requests);
  if (requiresCodeModeCompletion(requests, params.catalogProjection)) {
    params.owner.requireCompletion();
  }
  const pendingIds = new Set(pending.map((entry) => entry.id));
  const newPendingRequests = requests.filter((request) => !pendingIds.has(request.id));
  // Watchdog grace permits checkpoint/cleanup, never admission of new effects.
  if (newPendingRequests.length > 0 && params.budget.deadlineMs <= performance.now()) {
    throw new Error("interrupted");
  }
  pending.push(
    ...createPendingBridgeStates(newPendingRequests, {
      inbox: params.owner.inbox,
      results: params.owner.results,
      sessionStore: params.owner.sessionStore,
      runtime: params.runtime,
      catalogProjection: params.catalogProjection,
      namespaceRuntime: params.namespaceRuntime,
      parentToolCallId: params.parentToolCallId,
      codeModeRunId: params.codeModeReplayId,
      remainingMs: params.budget.deadlineMs - performance.now(),
      completionRequired: params.owner.completionRequired,
      activeRunId: params.owner.runId,
      ctx: params.ctx,
      signal: params.signal,
      onUpdate: params.onUpdate,
      bridgeDispatch: params.bridgeDispatch,
    }),
  );
}

function codeModeDiagnosticError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  // Worker notifications serialize Errors. Only native names may select a diagnostic category.
  const name = isRecord(error) ? error.name : undefined;
  const Constructor =
    [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].find(
      (candidate) => candidate.name === name,
    ) ?? Error;
  return new Constructor(codeModeFailureMessage(error));
}

export function createInlineHost(
  params: Omit<CodeModeSettlementContext, "result">,
  pending: PendingBridgeState[],
  reserve: () => void,
  onInputConsumed?: () => void,
): CodeModeExecutorInlineHost {
  return {
    gcAttribution: codeModeGcAttribution(params.owner.runId, params.ctx.sessionKey),
    onWorkerAssigned: (workerId) => {
      params.bridgeDispatch.workerId = workerId;
    },
    onFailure: (error, failurePhase, workerId = params.bridgeDispatch.workerId) => {
      // The bridge already recorded the original cause before guest projection.
      if (failurePhase === "bridge") {
        return;
      }
      logCodeModeFailure(codeModeDiagnosticError(error), {
        sessionId: params.ctx.sessionId,
        sessionKey: params.ctx.sessionKey,
        runId: params.ctx.runId,
        toolCallId: params.parentToolCallId,
        codeModeRunId: params.owner.runId,
        workerId,
        failurePhase,
        bridgeDispatchStarted: params.bridgeDispatch.started,
      });
    },
    onInputConsumed,
    onNetworkContent: () => params.runtime.observeNetworkContent(params.parentToolCallId),
    onBoundary: async (boundary, context) => {
      const durable = params.owner.durable;
      if (durable && boundary.pendingRequests.length === 0 && boundary.deterministicFingerprint) {
        await durable.start(boundary.deterministicFingerprint);
        return {
          kind: "continue",
          timeoutMs: context.maxTimeoutMs,
          pendingRequests: [],
          settledRequests: [],
        };
      }
      params.output.append(boundary.output);
      if (durable) {
        await durable.prepare(boundary.pendingRequests);
        const replay = await durable.replay(boundary);
        if (replay) {
          return {
            kind: "continue",
            timeoutMs: context.maxTimeoutMs,
            settledRequests: replay.replies,
            pendingRequests: replay.pending,
            deterministicTimeMs: replay.time,
          };
        }
      }
      cancelPendingBridgeStatesById(pending, boundary.canceledRequestIds);
      if (boundary.pendingRequests.some((request) => request.method === "yield")) {
        return { kind: "checkpoint" };
      }
      // Own an existing run slot before any host effect, through internal parking.
      reserve();
      await dispatchCodeModeRequests(params, pending, boundary.pendingRequests);
      // A ready required reply needs no checkpoint. Give immediate bridge promise
      // chains one turn to settle, charged to the original allowance. Actual waits
      // still park to pause guest time and release compute; pressure always wins.
      const signal = AbortSignal.any([params.signal, context.signal, context.yieldSignal]);
      if (params.owner.completionRequired) {
        if (signal.aborted || params.budget.deadlineMs <= performance.now()) {
          return { kind: "checkpoint" };
        }
        await yieldToScheduler();
        if (!isCodeModePendingReady(pending, boundary.settlementMode)) {
          return { kind: "checkpoint" };
        }
      }
      // Pressure parks the VM, never the cell-owned host operations.
      const ready = await waitForCodeModePending(
        pending,
        boundary.settlementMode,
        params.budget,
        params.approvalWait,
        signal,
        params.owner.registerAwaiting,
      );
      // The host timer owns exhaustion; do not open a second wait after checkpointing.
      if (!ready && !signal.aborted) {
        params.budget.deadlineMs = performance.now();
      }
      const timeoutMs = params.budget.deadlineMs - performance.now();
      if (!ready || signal.aborted || timeoutMs <= 0) {
        return { kind: "checkpoint" };
      }
      const delivery = takeSettledBridgeRequests(pending);
      let deterministicTimeMs: number | undefined;
      try {
        deterministicTimeMs = await params.owner.durable?.commitDelivery(delivery.requests);
      } catch (error) {
        delivery.release();
        throw error;
      }
      const unresolved = pending.filter((entry) => !entry.settled);
      pending.splice(0, pending.length, ...unresolved);
      return {
        kind: "continue",
        timeoutMs,
        settledRequests: delivery.requests,
        deterministicTimeMs,
        pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
        onConsumed: delivery.release,
      };
    },
  };
}
