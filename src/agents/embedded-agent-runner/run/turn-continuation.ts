import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Auto-reply may change presentation and tools, but cannot replace turn authority. */
export type EmbeddedTurnContinuationPolicy = Pick<
  RunEmbeddedAgentParams,
  | "permissionMode"
  | "toolsAllow"
  | "disableTools"
  | "disableMessageTool"
  | "forceMessageTool"
  | "conversationToolPolicy"
  | "terminalReplyExpectation"
  | "silentExpected"
  | "silentReplyPromptMode"
  | "sourceReplyDeliveryMode"
  | "onPartialReply"
  | "onBlockReply"
  | "onBlockReplyFlush"
  | "onReasoningStream"
  | "onReasoningEnd"
  | "onAssistantMessageStart"
  | "onAgentEvent"
  | "onToolResult"
  | "shouldEmitToolResult"
  | "shouldEmitToolOutput"
>;

export type EmbeddedTurnContinuationRequest = {
  prompt: string;
  policy?: EmbeddedTurnContinuationPolicy;
};

type EmbeddedSettledDraftDisposition =
  | { action: "publish" }
  | { action: "withhold" }
  | ({ action: "continue" } & EmbeddedTurnContinuationRequest);

/** Called after tool settlement and before the logical turn accepts its final draft. */
export type EmbeddedSettledDraftReviewer = (input: {
  attempt: EmbeddedRunAttemptResult;
  payloads: readonly ReplyPayload[];
  completedMessages: readonly AgentMessage[];
  signal: AbortSignal;
}) => Promise<EmbeddedSettledDraftDisposition>;
