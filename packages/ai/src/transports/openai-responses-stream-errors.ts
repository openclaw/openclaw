import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../types.js";

const OUTPUT_IDENTITY_ERROR_CODE = "responses_output_identity_conflict";

function outputType(type: string) {
  return type === "reasoning" ||
    type === "message" ||
    type === "function_call" ||
    type === "compaction"
    ? type
    : "other";
}

export function isResponsesProviderTool(item: { type: string }): boolean {
  return outputType(item.type) === "other";
}

/** Inspect the admitted request, including payload-hook changes and transport retries. */
export function hasOnlyResponsesFunctionTools(
  request: Record<string, unknown> | undefined,
): boolean {
  return (
    request !== undefined &&
    (request.tools === undefined ||
      (Array.isArray(request.tools) &&
        request.tools.every((tool) => isRecord(tool) && tool.type === "function")))
  );
}

export class ResponsesOutputIdentityError extends Error {
  readonly code = OUTPUT_IDENTITY_ERROR_CODE;
  readonly errorBody: string;

  constructor(details: {
    outputIndex?: number;
    expectedType: string;
    actualType: string;
    completed: boolean;
    completedToolCall: boolean;
    eventType: string;
    retrySafe: boolean;
  }) {
    super("Responses stream changed output item identity");
    this.name = "ResponsesOutputIdentityError";
    this.errorBody = JSON.stringify({
      ...details,
      expectedType: outputType(details.expectedType),
      actualType: outputType(details.actualType),
      mismatch: details.expectedType !== details.actualType ? "type" : "call_id",
      eventType:
        details.eventType === "response.output_item.added" ||
        details.eventType === "response.output_item.done" ||
        details.eventType === "response.completed" ||
        details.eventType === "response.incomplete"
          ? details.eventType
          : "unknown",
      retrySafe: details.retrySafe && !details.completedToolCall,
    });
  }
}

/** Resume only a response that could not have completed tools or exposed visible output. */
export function resolveResponsesOutputIdentityRetry(
  message: Pick<AssistantMessage, "errorCode"> &
    Partial<Pick<AssistantMessage, "stopReason" | "errorBody" | "content">>,
): "retry" | "stop" | undefined {
  if (message.errorCode !== OUTPUT_IDENTITY_ERROR_CODE) {
    return undefined;
  }
  return message.stopReason === "error" &&
    message.content?.every(
      (block) => block.type === "thinking" || (block.type === "text" && block.text.length === 0),
    ) === true &&
    safeParseJsonRecord(message.errorBody ?? "")?.retrySafe === true
    ? "retry"
    : "stop";
}
