import { formatErrorMessage } from "../../../infra/errors.js";
import { buildTrajectoryArtifacts } from "../../../trajectory/metadata.js";
import {
  type AttemptTrajectoryTerminal,
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

type FinalizeEmbeddedAttemptParams = {
  result: EmbeddedRunAttemptResult;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder | null;
  synthesizedPayloadCount: number;
  emptyAssistantReplyIsSilent: boolean;
  hasTerminalOutput: boolean;
  silentExpected?: boolean;
  /** Capture terminal classification for deferred session.ended after cleanup. */
  onTrajectoryTerminal?: (terminal: AttemptTrajectoryTerminal) => void;
};

/** Classifies the completed attempt and records its terminal trajectory artifacts. */
export function finalizeEmbeddedAttempt(
  params: FinalizeEmbeddedAttemptParams,
): EmbeddedRunAttemptResult {
  const { result, trajectoryRecorder } = params;
  const terminalAssistantTexts = resolveTerminalAssistantTexts({
    assistantTexts: result.assistantTexts,
    lastAssistantStopReason: result.lastAssistant?.stopReason,
    lastAssistantVisibleText: resolveFinalAssistantVisibleText(result.lastAssistant),
  });
  const terminal = resolveAttemptTrajectoryTerminal({
    promptError: result.promptError,
    aborted: result.aborted,
    externalAbort: result.externalAbort,
    timedOut: result.timedOut,
    assistantTexts: terminalAssistantTexts,
    toolMetas: result.toolMetas,
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    didSendDeterministicApprovalPrompt: result.didSendDeterministicApprovalPrompt === true,
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
    messagingToolSentTargets: result.messagingToolSentTargets,
    successfulCronAdds: result.successfulCronAdds ?? 0,
    synthesizedPayloadCount: params.synthesizedPayloadCount,
    acceptedSessionSpawns: result.acceptedSessionSpawns,
    heartbeatToolResponse: result.heartbeatToolResponse,
    clientToolCalls: result.clientToolCalls,
    yieldDetected: result.yieldDetected,
    lastToolError: result.lastToolError,
    silentExpected: params.silentExpected,
    emptyAssistantReplyIsSilent: params.emptyAssistantReplyIsSilent,
    lastAssistantStopReason: result.lastAssistant?.stopReason,
    hasTerminalOutput: params.hasTerminalOutput,
  });
  const promptError = result.promptError ? formatErrorMessage(result.promptError) : undefined;

  trajectoryRecorder?.recordEvent("model.completed", {
    aborted: result.aborted,
    externalAbort: result.externalAbort,
    timedOut: result.timedOut,
    idleTimedOut: result.idleTimedOut,
    timedOutDuringCompaction: result.timedOutDuringCompaction,
    timedOutDuringToolExecution: result.timedOutDuringToolExecution,
    timedOutByRunBudget: result.timedOutByRunBudget,
    promptError,
    promptErrorSource: result.promptErrorSource,
    terminalError: terminal.terminalError,
    usage: result.attemptUsage,
    promptCache: result.promptCache,
    compactionCount: result.compactionCount,
    assistantTexts: result.assistantTexts,
    finalPromptText: result.finalPromptText,
    messagesSnapshot: result.messagesSnapshot,
  });
  trajectoryRecorder?.recordEvent(
    "trace.artifacts",
    buildTrajectoryArtifacts({
      status: terminal.status,
      aborted: result.aborted,
      externalAbort: result.externalAbort,
      timedOut: result.timedOut,
      idleTimedOut: result.idleTimedOut,
      timedOutDuringCompaction: result.timedOutDuringCompaction,
      timedOutDuringToolExecution: result.timedOutDuringToolExecution === true,
      timedOutByRunBudget: result.timedOutByRunBudget === true,
      promptError,
      promptErrorSource: result.promptErrorSource,
      terminalError: terminal.terminalError,
      usage: result.attemptUsage,
      promptCache: result.promptCache,
      compactionCount: result.compactionCount ?? 0,
      assistantTexts: result.assistantTexts,
      finalPromptText: result.finalPromptText,
      itemLifecycle: result.itemLifecycle,
      toolMetas: result.toolMetas,
      didSendViaMessagingTool: result.didSendViaMessagingTool,
      successfulCronAdds: result.successfulCronAdds ?? 0,
      messagingToolSentTexts: result.messagingToolSentTexts,
      messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
      messagingToolSentTargets: result.messagingToolSentTargets,
      lastToolError: result.lastToolError,
    }),
  );
  // session.ended is recorded after attempt cleanup so its wall-clock timestamp
  // reflects real session termination, not model.completed (#102014).
  params.onTrajectoryTerminal?.(terminal);

  return result;
}
