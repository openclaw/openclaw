import { randomBytes } from "node:crypto";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type {
  EmbeddedPiAgentMeta,
  EmbeddedPiRunResult,
  EmbeddedRunFailureSignal,
  EmbeddedRunLivenessState,
  ToolSummaryTrace,
  TraceAttempt,
} from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export type EmbeddedRunTerminalResult = EmbeddedPiRunResult & {
  didSendDeterministicApprovalPrompt?: boolean;
};

export function resolveEmbeddedRunStopReason(params: {
  clientToolCall?: EmbeddedRunAttemptResult["clientToolCall"];
  yieldDetected?: boolean;
  assistantStopReason?: string;
}): string | undefined {
  if (params.clientToolCall) {
    return "tool_calls";
  }
  if (params.yieldDetected) {
    return "end_turn";
  }
  return params.assistantStopReason;
}

export function buildEmbeddedRunExecutionTrace(params: {
  traceAttempts: TraceAttempt[];
  winnerProvider: string;
  winnerModel: string;
  includeSuccessAttempt?: boolean;
}): EmbeddedPiRunResult["meta"]["executionTrace"] {
  const successRow = params.includeSuccessAttempt
    ? [
        {
          provider: params.winnerProvider,
          model: params.winnerModel,
          result: "success" as const,
          stage: "assistant" as const,
        },
      ]
    : [];
  const hasAttempts = params.traceAttempts.length > 0 || successRow.length > 0;
  const attempts = hasAttempts ? [...params.traceAttempts, ...successRow] : undefined;
  return {
    winnerProvider: params.winnerProvider,
    winnerModel: params.winnerModel,
    attempts,
    fallbackUsed: params.traceAttempts.length > 0,
    runner: "embedded",
  };
}

export function buildEmbeddedRunTerminalResult(params: {
  attempt: Pick<
    EmbeddedRunAttemptResult,
    | "agentHarnessResultClassification"
    | "clientToolCall"
    | "diagnosticTrace"
    | "didSendDeterministicApprovalPrompt"
    | "didSendViaMessagingTool"
    | "finalPromptText"
    | "messagingToolSentMediaUrls"
    | "messagingToolSentTargets"
    | "messagingToolSentTexts"
    | "successfulCronAdds"
    | "systemPromptReport"
  >;
  payloadsWithToolMedia?: EmbeddedPiRunResult["payloads"];
  emptyAssistantReplyIsSilent: boolean;
  durationMs: number;
  agentMeta: EmbeddedPiAgentMeta;
  aborted: boolean;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  replayInvalid?: boolean;
  livenessState: EmbeddedRunLivenessState;
  stopReason?: string;
  traceAttempts: TraceAttempt[];
  winnerProvider: string;
  winnerModel: string;
  includeSuccessTraceAttempt?: boolean;
  lastProfileId?: string;
  thinkLevel?: string;
  reasoningLevel?: string;
  verboseLevel?: string;
  blockReplyBreak?: string;
  toolSummary?: ToolSummaryTrace;
  failureSignal?: EmbeddedRunFailureSignal;
  autoCompactionCount: number;
  toolCallIdFactory?: () => string;
}): EmbeddedRunTerminalResult {
  const terminalPayloads = params.emptyAssistantReplyIsSilent
    ? [{ text: SILENT_REPLY_TOKEN }]
    : params.payloadsWithToolMedia;
  const makeToolCallId =
    params.toolCallIdFactory ?? (() => randomBytes(5).toString("hex").slice(0, 9));
  return {
    payloads: terminalPayloads?.length ? terminalPayloads : undefined,
    ...(params.attempt.diagnosticTrace
      ? { diagnosticTrace: freezeDiagnosticTraceContext(params.attempt.diagnosticTrace) }
      : {}),
    meta: {
      durationMs: params.durationMs,
      agentMeta: params.agentMeta,
      aborted: params.aborted,
      systemPromptReport: params.attempt.systemPromptReport,
      finalPromptText: params.attempt.finalPromptText,
      finalAssistantVisibleText: params.finalAssistantVisibleText,
      finalAssistantRawText: params.finalAssistantRawText,
      replayInvalid: params.replayInvalid,
      livenessState: params.livenessState,
      agentHarnessResultClassification: params.attempt.agentHarnessResultClassification,
      ...(params.emptyAssistantReplyIsSilent ? { terminalReplyKind: "silent-empty" as const } : {}),
      stopReason: params.stopReason,
      pendingToolCalls: params.attempt.clientToolCall
        ? [
            {
              id: makeToolCallId(),
              name: params.attempt.clientToolCall.name,
              arguments: JSON.stringify(params.attempt.clientToolCall.params),
            },
          ]
        : undefined,
      executionTrace: buildEmbeddedRunExecutionTrace({
        traceAttempts: params.traceAttempts,
        winnerProvider: params.winnerProvider,
        winnerModel: params.winnerModel,
        includeSuccessAttempt: params.includeSuccessTraceAttempt,
      }),
      requestShaping: {
        ...(params.lastProfileId ? { authMode: "auth-profile" } : {}),
        ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
        ...(params.reasoningLevel ? { reasoning: params.reasoningLevel } : {}),
        ...(params.verboseLevel ? { verbose: params.verboseLevel } : {}),
        ...(params.blockReplyBreak ? { blockStreaming: params.blockReplyBreak } : {}),
      },
      toolSummary: params.toolSummary,
      ...(params.failureSignal ? { failureSignal: params.failureSignal } : {}),
      completion: {
        ...(params.stopReason ? { stopReason: params.stopReason } : {}),
        ...(params.stopReason ? { finishReason: params.stopReason } : {}),
        ...(params.stopReason?.toLowerCase().includes("refusal") ? { refusal: true } : {}),
      },
      contextManagement:
        params.autoCompactionCount > 0
          ? { lastTurnCompactions: params.autoCompactionCount }
          : undefined,
    },
    didSendViaMessagingTool: params.attempt.didSendViaMessagingTool,
    didSendDeterministicApprovalPrompt: params.attempt.didSendDeterministicApprovalPrompt,
    messagingToolSentTexts: params.attempt.messagingToolSentTexts,
    messagingToolSentMediaUrls: params.attempt.messagingToolSentMediaUrls,
    messagingToolSentTargets: params.attempt.messagingToolSentTargets,
    successfulCronAdds: params.attempt.successfulCronAdds,
  };
}
