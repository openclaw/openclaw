import type { AgentMessage } from "./types.js";

export const TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE = "openclaw_transcript_not_continuable";
export const REPEATED_TOOL_ERROR_CODE = "openclaw_repeated_tool_error";
export const REPEATED_TOOL_ERROR_MESSAGE =
  "OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.";

export class TranscriptNotContinuableError extends Error {
  public readonly code = TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE;
  public readonly role: AgentMessage["role"];

  constructor(role: AgentMessage["role"]) {
    super(`Cannot continue from message role: ${role}`);
    this.name = "TranscriptNotContinuableError";
    this.role = role;
  }
}
