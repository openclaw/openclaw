/** Canonical persisted receipt, before the Gateway's public-history projection. */
export function nestedToolActivityFixture(params: {
  toolName: string;
  toolCallId: string;
  input: unknown;
  text: string;
  isError?: boolean;
}) {
  return {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    display: true,
    excludeFromContext: true,
    content: "",
    details: {
      runId: "run-qa",
      scopeId: "scope-qa",
      afterEntryId: "entry-qa",
      startOrder: 0,
      parentToolCallId: "exec-qa",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      input: params.input,
      result: { content: [{ type: "text", text: params.text }] },
      isError: params.isError ?? false,
      startedAt: 100,
      timestamp: 150,
    },
    timestamp: 100,
  };
}

/** Public history retains correlated blocks and removes private receipt details. */
export function nestedToolHistoryFixture(params: Parameters<typeof nestedToolActivityFixture>[0]) {
  const { details, ...message } = nestedToolActivityFixture(params);
  const { input, result, ...activity } = details;
  return {
    ...message,
    runId: activity.runId,
    __openclaw: { runId: activity.runId },
    content: [
      {
        type: "toolCall",
        id: activity.toolCallId,
        runId: activity.runId,
        name: activity.toolName,
        arguments: input,
        parentToolCallId: activity.parentToolCallId,
        timestamp: activity.startedAt,
      },
      { ...activity, ...result, type: "toolResult", role: "toolResult" },
    ],
  };
}
