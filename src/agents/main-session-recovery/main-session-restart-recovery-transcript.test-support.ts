export const textContent = <T>(text: T) => [{ type: "text", text }];

export function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}

function toolCallMessage(content: unknown[]) {
  return { role: "assistant", content, stopReason: "toolUse" };
}

export function makeUserMessage(content = "do the thing", overrides: Record<string, unknown> = {}) {
  return { role: "user", content, ...overrides };
}

export function makeToolResultMessage(
  content: unknown = "done",
  overrides: Record<string, unknown> = {},
) {
  return { role: "toolResult", content, ...overrides };
}

export function makeAssistantTextMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: textContent(text),
    ...overrides,
  };
}

export function makeMessageToolCall(
  toolCallId = "message-call-1",
  message = "delivered answer",
  overrides: Record<string, unknown> = {},
) {
  return toolCallMessage([
    {
      ...toolCall(toolCallId, "message", { action: "send", message }),
      ...overrides,
    },
  ]);
}

export function makeMessageToolResult(
  toolCallId = "message-call-1",
  overrides: Record<string, unknown> = {},
) {
  return makeToolResultMessage([{ type: "text", text: "sent" }], {
    toolCallId,
    toolName: "message",
    isError: false,
    ...overrides,
  });
}

export function makeMessageDeliveryTranscript({
  beforeCall = [],
  content = "do the thing",
  message = "delivered answer",
  sourceRunId = "discord-message-1",
  toolCallId = "message-call-1",
  tail = [],
}: {
  beforeCall?: readonly unknown[];
  content?: string;
  message?: string;
  sourceRunId?: string;
  toolCallId?: string;
  tail?: readonly unknown[];
} = {}) {
  return [
    makeUserMessage(content, { idempotencyKey: sourceRunId }),
    ...beforeCall,
    makeMessageToolCall(toolCallId, message),
    ...tail,
  ];
}

export function codeModeCheckpointMessage(
  toolName: "exec" | "wait" = "wait",
  checkpoint: Record<string, unknown> = {
    status: "waiting",
    runId: "cm_interrupted",
    replaySafe: true,
  },
) {
  return {
    role: "toolResult",
    toolName,
    content: textContent(JSON.stringify(checkpoint)),
  };
}

export function codeModeWaitCallMessage(runId = "cm_interrupted", id = "call-wait-1") {
  return toolCallMessage([toolCall(id, "wait", { runId })]);
}
