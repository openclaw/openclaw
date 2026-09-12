import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import {
  formatAgentRunRouteChange,
  normalizeAgentRunTerminalReceipt,
} from "../agent-run-terminal-receipt.js";
import {
  buildAgentRunTerminalReplySnapshot,
  normalizeAgentRunTerminalReplySnapshot,
} from "../agent-run-terminal-reply.js";
import type { FallbackAttempt } from "../model-fallback.types.js";
import { isProviderModelRerouted } from "../provider-model-route.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "./types.js";

export type RunEntryTerminalBehavior =
  | {
      kind: "channel-delivery";
      readDeliveryEvidence: () => {
        hasRetryBlockedDelivery: boolean;
        hasDirectlySentBlockReply: boolean;
        hasBlockReplyPipelineOutput: boolean;
      };
    }
  | { kind: "followup-delivery" }
  | {
      kind: "command-rpc";
      hasCommittedSideEffect: () => boolean;
    }
  | { kind: "maintenance" };

export type EmbeddedAgentRunEntryTerminal = {
  outcome: ReturnType<typeof buildAgentRunTerminalOutcomeFromLifecycleEvent>;
  metadata: Record<string, unknown>;
};

export function resolveRunEntryTerminalOutcome(params: {
  result: EmbeddedAgentRunResult;
  fallbackExhausted: boolean;
}): EmbeddedAgentRunEntryTerminal["outcome"] {
  const meta = params.result.meta;
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: params.fallbackExhausted || meta.error ? "error" : "end",
    data: { ...meta, error: meta.error?.message },
  });
}

export function canAdvanceContextEngineTurn(params: {
  result: EmbeddedAgentRunResult;
  fallbackOutcome: "completed" | "exhausted";
  terminal: EmbeddedAgentRunEntryTerminal;
}): boolean {
  const meta = params.result.meta;
  return (
    params.fallbackOutcome === "completed" &&
    params.terminal.outcome.status === "ok" &&
    meta.yielded !== true &&
    meta.aborted !== true &&
    meta.error === undefined &&
    meta.timeoutPhase === undefined &&
    meta.stopReason !== "error" &&
    meta.stopReason !== "timeout"
  );
}

export function mergeRunEntryExecutionTrace<T extends EmbeddedAgentRunResult>(params: {
  result: T;
  terminalStatus: EmbeddedAgentRunEntryTerminal["outcome"]["status"];
  provider: string;
  model: string;
  requestedProvider: string;
  requestedModel: string;
  fallbackAttempts: FallbackAttempt[];
}): T {
  const currentTrace = params.result.meta.executionTrace;
  const winnerProvider =
    params.terminalStatus === "ok" ? (currentTrace?.winnerProvider ?? params.provider) : undefined;
  const winnerModel =
    params.terminalStatus === "ok" ? (currentTrace?.winnerModel ?? params.model) : undefined;
  const outerAttempts: TraceAttempt[] = params.fallbackAttempts.map((attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    result: attempt.reason === "timeout" ? "timeout" : "candidate_failed",
    ...(attempt.reason ? { reason: attempt.reason } : {}),
    ...(typeof attempt.status === "number" ? { status: attempt.status } : {}),
  }));
  const innerAttempts = (currentTrace?.attempts ?? []).filter(
    (attempt) => attempt.result !== "success",
  );
  const winnerAttempt = currentTrace?.attempts?.findLast(
    (attempt) =>
      attempt.result === "success" &&
      attempt.provider === winnerProvider &&
      attempt.model === winnerModel,
  );
  const attempts = [
    ...outerAttempts,
    ...innerAttempts,
    ...(winnerProvider && winnerModel
      ? [
          winnerAttempt ?? {
            provider: winnerProvider,
            model: winnerModel,
            result: "success" as const,
          },
        ]
      : []),
  ];
  const terminalReceipt = params.result.meta.agentMeta?.terminalReceipt;
  const requested = { provider: params.requestedProvider, model: params.requestedModel };
  const agentMeta = terminalReceipt
    ? {
        ...params.result.meta.agentMeta,
        terminalReceipt: {
          ...terminalReceipt,
          requested,
          rerouted:
            terminalReceipt.rerouted ||
            isProviderModelRerouted(requested, terminalReceipt.effective),
        },
      }
    : params.result.meta.agentMeta;
  return {
    ...params.result,
    meta: {
      ...params.result.meta,
      agentMeta,
      executionTrace: {
        ...currentTrace,
        winnerProvider,
        winnerModel,
        attempts: attempts.length > 0 ? attempts : undefined,
        fallbackUsed: currentTrace?.fallbackUsed === true || outerAttempts.length > 0,
      },
    },
  };
}

export function buildRunEntryTerminal(params: {
  result: EmbeddedAgentRunResult;
  outcome: EmbeddedAgentRunEntryTerminal["outcome"];
  behavior: RunEntryTerminalBehavior;
  runId: string;
  requested: { provider: string; model: string };
  sessionId: string;
}): EmbeddedAgentRunEntryTerminal {
  const meta = params.result.meta;
  const outcome = params.outcome;
  const internalReply = params.result.messagingToolSourceReplyPayloads?.findLast(
    (payload) => payload.sourceReplyFinal === true,
  );
  let terminalReply =
    normalizeAgentRunTerminalReplySnapshot(meta.terminalReply) ??
    buildAgentRunTerminalReplySnapshot(
      // Internal UI delivery still needs forwarding by A2A. Its final payload
      // owns that reply even when the model subsequently emits NO_REPLY.
      internalReply
        ? { visibleText: internalReply.text }
        : {
            visibleText: meta.finalAssistantVisibleText,
            rawText: meta.finalAssistantRawText,
            terminalReplyKind: meta.terminalReplyKind,
          },
    );
  const agentMeta = meta.agentMeta;
  const normalizedTerminalReceipt =
    normalizeAgentRunTerminalReceipt(agentMeta?.terminalReceipt) ??
    // CLI backends report delivery without an embedded model-turn receipt.
    // The entry owner supplies run identity; the tool supplied the send fact.
    (params.result.sourceReplyDelivered && agentMeta?.provider && agentMeta.model
      ? {
          runId: params.runId,
          sessionId: params.sessionId,
          turnId: params.runId,
          requested: params.requested,
          effective: {
            provider: agentMeta.provider,
            model: agentMeta.model,
            responseModel: agentMeta.model,
          },
          successfulToolNames: ["message"],
          sourceReplyDelivered: true as const,
          rerouted: isProviderModelRerouted(params.requested, {
            provider: agentMeta.provider,
            model: agentMeta.model,
          }),
        }
      : undefined);
  const terminalReceipt =
    normalizedTerminalReceipt?.runId === params.runId
      ? {
          ...normalizedTerminalReceipt,
          terminalDisposition:
            terminalReply.disposition === "visible"
              ? ("visible" as const)
              : ("not-visible" as const),
        }
      : undefined;
  const modelRouteChange = formatAgentRunRouteChange(terminalReceipt, params.runId);
  if (modelRouteChange && terminalReply.disposition === "visible") {
    // Carry one receipt-owned fact beside assistant text so internal parents can
    // report the reroute without exposing it through raw external delivery.
    terminalReply = { ...terminalReply, modelRouteChange };
  }
  const metadata: Record<string, unknown> = { terminalReply };
  if (terminalReceipt) {
    metadata.terminalReceipt = terminalReceipt;
  }
  if (params.behavior.kind === "channel-delivery" || params.behavior.kind === "followup-delivery") {
    for (const key of [
      "stopReason",
      "yielded",
      "timeoutPhase",
      "providerStarted",
      "aborted",
      "livenessState",
      "replayInvalid",
    ] as const) {
      if (!Object.hasOwn(meta, key)) {
        continue;
      }
      // SAFETY: every listed key is shared by the terminal outcome and run metadata shapes.
      metadata[key] = key in outcome ? outcome[key as keyof typeof outcome] : meta[key];
    }
  } else {
    for (const key of ["stopReason", "livenessState", "timeoutPhase", "providerStarted"] as const) {
      if (outcome[key] !== undefined) {
        metadata[key] = outcome[key];
      }
    }
    if (typeof meta.aborted === "boolean") {
      metadata.aborted = meta.aborted;
    }
    if (meta.replayInvalid === true) {
      metadata.replayInvalid = true;
    }
    if (meta.yielded === true) {
      metadata.yielded = true;
    }
  }
  return { outcome, metadata };
}
