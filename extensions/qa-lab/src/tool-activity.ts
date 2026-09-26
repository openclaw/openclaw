import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function isCorrelationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function readHistoryActivity(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    message.details !== undefined ||
    !Array.isArray(message.content) ||
    message.content.length !== 2
  ) {
    return undefined;
  }
  const [call, result] = message.content;
  const metadata = message["__openclaw"];
  if (
    !isRecord(call) ||
    !isRecord(result) ||
    call.type !== "toolCall" ||
    result.type !== "toolResult" ||
    result.role !== "toolResult" ||
    !isCorrelationId(message.runId) ||
    !isRecord(metadata) ||
    metadata.runId !== message.runId ||
    call.runId !== message.runId ||
    result.runId !== call.runId ||
    call.id !== result.toolCallId ||
    call.name !== result.toolName ||
    call.parentToolCallId !== result.parentToolCallId ||
    call.timestamp !== result.startedAt ||
    !Object.hasOwn(call, "arguments")
  ) {
    return undefined;
  }
  // Public history strips private details after publishing these correlated blocks.
  return {
    ...result,
    input: call.arguments,
    result: { content: result.content, details: result.details },
  };
}

/** Read a terminal receipt or its canonical public-history projection. */
export function readQaNestedToolActivity(message: Record<string, unknown>) {
  if (
    message.role !== "custom" ||
    message.customType !== "openclaw.nested-tool.v1" ||
    message.display !== true ||
    message.excludeFromContext !== true ||
    (message.content !== "" && !Array.isArray(message.content)) ||
    typeof message.timestamp !== "number" ||
    !Number.isFinite(message.timestamp)
  ) {
    return undefined;
  }
  const details =
    message.content === ""
      ? isRecord(message.details)
        ? message.details
        : undefined
      : readHistoryActivity(message);
  if (
    !details ||
    !isCorrelationId(details.runId) ||
    !isCorrelationId(details.scopeId) ||
    (details.afterEntryId !== null && !isCorrelationId(details.afterEntryId)) ||
    typeof details.startOrder !== "number" ||
    !Number.isSafeInteger(details.startOrder) ||
    details.startOrder < 0 ||
    (details.parentToolCallId !== undefined && !isCorrelationId(details.parentToolCallId)) ||
    !isCorrelationId(details.toolCallId) ||
    typeof details.toolName !== "string" ||
    details.toolName.length === 0 ||
    details.toolName.length > 256 ||
    typeof details.isError !== "boolean" ||
    typeof details.startedAt !== "number" ||
    !Number.isFinite(details.startedAt) ||
    typeof details.timestamp !== "number" ||
    !Number.isFinite(details.timestamp) ||
    !Object.hasOwn(details, "input") ||
    !isRecord(details.result) ||
    !Array.isArray(details.result.content)
  ) {
    return undefined;
  }
  return {
    runId: details.runId,
    scopeId: details.scopeId,
    afterEntryId: details.afterEntryId,
    startOrder: details.startOrder,
    parentToolCallId: details.parentToolCallId,
    toolCallId: details.toolCallId,
    toolName: details.toolName,
    isError: details.isError,
    input: details.input,
    timestamp: details.timestamp,
    startedAt: details.startedAt,
    result: details.result,
  };
}

/** QA-only call/result view; never writes synthetic turns into the transcript. */
export function projectQaToolMessages(messages: readonly unknown[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (!isRecord(message)) {
      return [];
    }
    if (message.role !== "custom") {
      return [message];
    }
    const nested = readQaNestedToolActivity(message);
    if (!nested) {
      // Custom display blocks alone are not correlated execution evidence.
      return [];
    }
    const { input, result, ...activity } = nested;
    return [
      {
        role: "assistant",
        content: [
          {
            ...activity,
            type: "toolCall",
            id: activity.toolCallId,
            name: activity.toolName,
            arguments: input,
            timestamp: activity.startedAt,
          },
        ],
      },
      { ...result, ...activity, role: "toolResult" },
    ];
  });
}
