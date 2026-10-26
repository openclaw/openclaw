import type { AgentMessage } from "./types.js";

export const TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE = "openclaw_transcript_not_continuable";
export const REPETITIVE_OUTPUT_ERROR_MESSAGE =
  "Repetitive output stopped. Try a larger model or shorten your request before retrying.";
export const REPEATED_TOOL_ERROR_CODE = "openclaw_repeated_tool_error";
export const REPEATED_TOOL_ERROR_MESSAGE =
  "OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.";

/** A tool rejected model-authored arguments during prepareArguments, before execution. */
export class ToolArgumentValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolArgumentValidationError";
  }
}

export class TranscriptNotContinuableError extends Error {
  public readonly code = TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE;
  public readonly role: AgentMessage["role"];

  constructor(role: AgentMessage["role"]) {
    super(`Cannot continue from message role: ${role}`);
    this.name = "TranscriptNotContinuableError";
    this.role = role;
  }
}
