import {
  hasAcceptedSessionSpawn,
  type AcceptedSessionSpawn,
} from "../../accepted-session-spawn.js";

export type AttemptTrajectoryTerminalStatus = "success" | "error" | "interrupted";

export const NON_DELIVERABLE_TERMINAL_TURN_REASON = "non_deliverable_terminal_turn";

/**
 * Terminal trajectory result with an optional non-deliverable failure reason.
 * `terminalError` is intentionally narrower than status so trajectory consumers
 * can distinguish "attempt failed" from "attempt produced no durable outcome".
 */
export type AttemptTrajectoryTerminal = {
  status: AttemptTrajectoryTerminalStatus;
  terminalError?: typeof NON_DELIVERABLE_TERMINAL_TURN_REASON;
};

/**
 * Inputs used to classify whether the attempt delivered anything terminal.
 * This shape gathers all visible-progress channels before cleanup so trajectory
 * metadata does not need to inspect provider/tool internals later.
 */
export type ResolveAttemptTrajectoryTerminalParams = {
  promptError?: unknown;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  assistantTexts: string[];
  toolMetas: Array<{
    toolName: string;
    meta?: string;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
  didSendViaMessagingTool: boolean;
  didSendDeterministicApprovalPrompt: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: unknown[];
  successfulCronAdds: number;
  synthesizedPayloadCount: number;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  heartbeatToolResponse?: unknown;
  clientToolCalls?: Array<unknown>;
  yieldDetected?: boolean;
  lastToolError?: unknown;
  silentExpected?: boolean;
  emptyAssistantReplyIsSilent?: boolean;
  lastAssistantStopReason?: string;
};

export function resolveTerminalAssistantTexts(params: {
  assistantTexts: string[];
  lastAssistantStopReason?: string;
  lastAssistantVisibleText?: string;
}): string[] {
  if (hasNonEmptyAssistantText(params.assistantTexts)) {
    return params.assistantTexts;
  }
  if (params.lastAssistantStopReason === "error" || params.lastAssistantStopReason === "aborted") {
    return params.assistantTexts;
  }
  const fallbackText = params.lastAssistantVisibleText?.trim();
  return fallbackText ? [fallbackText] : params.assistantTexts;
}

function hasNonEmptyAssistantText(texts: string[]): boolean {
  return texts.some((text) => text.trim().length > 0);
}

function hasNonEmptyString(values: string[]): boolean {
  return values.some((value) => value.trim().length > 0);
}

function hasCommittedMessagingDeliveryEvidence(
  params: Pick<
    ResolveAttemptTrajectoryTerminalParams,
    "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets"
  >,
): boolean {
  // didSendViaMessagingTool means the tool path was attempted; only committed
  // text/media/target evidence proves a reply actually reached users.
  return (
    hasNonEmptyString(params.messagingToolSentTexts) ||
    hasNonEmptyString(params.messagingToolSentMediaUrls) ||
    params.messagingToolSentTargets.length > 0
  );
}

function hasAsyncStartedToolActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}

/**
 * Classifies the attempt's final trajectory status from delivery/progress
 * evidence. Success requires visible text, committed delivery, accepted
 * delegation, silent-turn policy, or other durable progress; plain tool
 * metadata alone is not enough.
 */
export function resolveAttemptTrajectoryTerminal(
  params: ResolveAttemptTrajectoryTerminalParams,
): AttemptTrajectoryTerminal {
  if (params.promptError) {
    return { status: "error" };
  }
  if ((params.aborted && params.externalAbort) || params.timedOut) {
    return { status: "interrupted" };
  }

  const hasExplicitTerminalDelivery =
    params.silentExpected === true ||
    params.emptyAssistantReplyIsSilent === true ||
    params.didSendDeterministicApprovalPrompt ||
    hasCommittedMessagingDeliveryEvidence(params) ||
    hasAcceptedSessionSpawn(params.acceptedSessionSpawns) ||
    params.synthesizedPayloadCount > 0 ||
    params.heartbeatToolResponse !== undefined ||
    (params.clientToolCalls?.length ?? 0) > 0 ||
    params.yieldDetected === true ||
    params.lastToolError !== undefined ||
    hasAsyncStartedToolActivity(params.toolMetas);

  if (params.lastAssistantStopReason === "toolUse" && !hasExplicitTerminalDelivery) {
    return {
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    };
  }

  const hasDeliverableOrProgress =
    hasExplicitTerminalDelivery ||
    hasNonEmptyAssistantText(params.assistantTexts) ||
    params.successfulCronAdds > 0;

  if (hasDeliverableOrProgress) {
    return { status: "success" };
  }

  return {
    status: "error",
    terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
  };
}
