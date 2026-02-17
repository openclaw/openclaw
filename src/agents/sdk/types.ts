/**
 * Shared types for the claude-agent-sdk adapter layer.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";
import type { NormalizedUsage } from "../usage.js";

/**
 * Result of consuming the SDK stream. This is mapped to EmbeddedRunAttemptResult
 * by the SDK attempt runner.
 */
export type SdkStreamResult = {
  sessionId: string;
  aborted: boolean;
  timedOut: boolean;
  error: unknown;
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
  successfulCronAdds: number;
  usage: NormalizedUsage | undefined;
  compactionCount: number;
};

/** Names of SDK built-in tools that openclaw should NOT wrap as MCP tools. */
export const SDK_BUILTIN_TOOL_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "NotebookEdit",
  "Task",
  "TaskOutput",
  "TaskStop",
  "AskUserQuestion",
  "ExitPlanMode",
  "TodoWrite",
]);

/**
 * Check if a tool name is a built-in SDK tool that the SDK handles natively.
 * These tools should not be wrapped as MCP tools.
 */
export function isSdkBuiltinTool(name: string): boolean {
  return SDK_BUILTIN_TOOL_NAMES.has(name);
}
