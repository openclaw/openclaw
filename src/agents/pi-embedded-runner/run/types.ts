import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { MessagingToolSend } from "../../pi-embedded-messaging.js";
import type { AuthStorage, ModelRegistry } from "../../pi-model-discovery.js";
import type { NormalizedUsage } from "../../usage.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedPiAgentParams,
  "provider" | "model" | "authProfileId" | "authProfileIdSource" | "thinkLevel" | "lane" | "enqueue"
>;

export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  provider: string;
  modelId: string;
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
};

/**
 * Snapshot of tool execution state captured when a timeout occurs during tool execution.
 * Provides debugging context including the tool name, call ID, and start timestamp.
 *
 * This field is only populated when ALL of the following conditions are met:
 * 1. Valid tool state was captured in the timeout handler
 * 2. Captured data passed validation (non-empty, lengths <= 100 chars, valid timestamp)
 * 3. Tool duration calculation was valid (> 0ms and < 24 hours)
 *
 * May be undefined even when `timedOutDuringToolExecution` is true if:
 * - State was cleared before snapshot could be taken (tool completed immediately before timeout)
 * - Captured state failed validation (corrupted or stale data)
 * - Duration calculation failed (negative or unreasonably large)
 *
 * Use this for diagnostics and logging. Presence of this field indicates high confidence
 * that the timeout was caused by a specific long-running tool rather than provider issues.
 */
export type ToolExecutionSnapshot = {
  /** The normalized name of the tool that was executing when timeout occurred. */
  toolName: string;
  /** The unique call ID for this specific tool invocation. */
  toolCallId: string;
  /** Unix timestamp (milliseconds) when the tool execution started. */
  startTime: number;
};

export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  timedOut: boolean;
  /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean;
  /** True if the timeout occurred while tool execution was in progress. */
  timedOutDuringToolExecution: boolean;
  /**
   * Snapshot of active tool when timeout occurred during tool execution.
   * Only present when valid tool state was captured and validated.
   * See ToolExecutionSnapshot type for detailed documentation on when this is populated.
   */
  toolExecutionSnapshot?: ToolExecutionSnapshot;
  promptError: unknown;
  sessionIdUsed: string;
  systemPromptReport?: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: {
    toolName: string;
    meta?: string;
    error?: string;
    mutatingAction?: boolean;
    actionFingerprint?: string;
  };
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  compactionCount?: number;
  /** Client tool call detected (OpenResponses hosted tools). */
  clientToolCall?: { name: string; params: Record<string, unknown> };
};
