import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isContractToolCallBlock, readToolCallName } from "../../../shared/tool-block-contract.js";

export function assistantCallsSessionsYield(message: unknown): boolean {
  const record = asOptionalRecord(message);
  if (!record || record.role !== "assistant") {
    return false;
  }
  if (
    Array.isArray(record.content) &&
    record.content.some(
      (block) => isContractToolCallBlock(block) && readToolCallName(block) === "sessions_yield",
    )
  ) {
    return true;
  }
  return [record.toolCalls, record.tool_calls].some(
    (toolCalls) =>
      Array.isArray(toolCalls) &&
      toolCalls.some((toolCall) => {
        const callRecord = asOptionalRecord(toolCall);
        return callRecord ? readToolCallName(callRecord) === "sessions_yield" : false;
      }),
  );
}

function readStructuredToolPayload(content: unknown): Record<string, unknown> | undefined {
  const record = asOptionalRecord(content);
  if (record) {
    return record;
  }
  if (typeof content === "string") {
    return safeParseJsonRecord(content.trim());
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const text = asOptionalRecord(block)?.text;
    if (typeof text !== "string") {
      continue;
    }
    const parsed = safeParseJsonRecord(text.trim());
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function isSessionsYieldToolResult(
  message: unknown,
  previousAssistantCalledYield: boolean,
): boolean {
  const record = asOptionalRecord(message);
  if (!record || (record.role !== "toolResult" && record.role !== "tool")) {
    return false;
  }
  const toolName = readToolCallName(record);
  if (toolName === "sessions_yield") {
    return true;
  }
  if (!previousAssistantCalledYield) {
    return false;
  }
  // Some providers omit the tool name on results; use adjacency plus yielded status as fallback.
  const details = asOptionalRecord(record.details);
  if (details?.status === "yielded") {
    return true;
  }
  const payload = readStructuredToolPayload(record.content);
  return payload?.status === "yielded";
}
