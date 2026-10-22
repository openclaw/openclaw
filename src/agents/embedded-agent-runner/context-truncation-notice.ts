import type { AgentMessage } from "../runtime/index.js";

export function formatContextLimitTruncationNotice(truncatedChars: number): string {
  return `[... ${Math.max(1, Math.floor(truncatedChars))} more characters truncated; rerun with narrower args if needed]`;
}

export function forMessage(message: AgentMessage): (truncatedChars: number) => string {
  return message.role === "toolResult" && message.toolName === "sessions_send"
    ? (chars) =>
        `[... ${chars} more characters truncated; ask the target session for the missing section or a file containing the full reply; do not repeat the original task]`
    : formatContextLimitTruncationNotice;
}
