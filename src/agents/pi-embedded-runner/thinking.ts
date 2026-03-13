import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type DropThinkingBlocksOptions = {
  preserveLatestAssistantMessage?: boolean;
};

function isReplayProtectedThinkingType(type: unknown): boolean {
  return type === "thinking" || type === "redacted_thinking";
}

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

export function findLatestAssistantMessageIndex(messages: AgentMessage[]): number {
  return messages.findLastIndex((message) => isAssistantMessageWithContent(message));
}

export function latestAssistantMessageHasReplayProtectedBlocks(messages: AgentMessage[]): boolean {
  const latestAssistantIndex = findLatestAssistantMessageIndex(messages);
  if (latestAssistantIndex < 0) {
    return false;
  }
  const latestAssistant = messages[latestAssistantIndex];
  if (!latestAssistant || !isAssistantMessageWithContent(latestAssistant)) {
    return false;
  }
  return latestAssistant.content.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      isReplayProtectedThinkingType((block as { type?: unknown }).type),
  );
}

function assistantMessageHasReplayProtectedBlocks(message: AgentMessage): boolean {
  if (!isAssistantMessageWithContent(message)) {
    return false;
  }
  return message.content.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      isReplayProtectedThinkingType((block as { type?: unknown }).type),
  );
}

export function assertReplayProtectionIntact(
  original: AgentMessage[],
  transformed: AgentMessage[],
  label: string,
): void {
  const originalLatestAssistantIndex = findLatestAssistantMessageIndex(original);
  if (originalLatestAssistantIndex < 0) {
    return;
  }

  const originalLatestAssistant = original[originalLatestAssistantIndex];
  if (
    !originalLatestAssistant ||
    !assistantMessageHasReplayProtectedBlocks(originalLatestAssistant)
  ) {
    return;
  }

  const transformedLatestAssistantIndex = findLatestAssistantMessageIndex(transformed);
  if (transformedLatestAssistantIndex < 0) {
    throw new Error(
      `${label}: replay-protected latest assistant message was removed during transcript sanitization`,
    );
  }

  const transformedLatestAssistant = transformed[transformedLatestAssistantIndex];
  if (
    !transformedLatestAssistant ||
    !isAssistantMessageWithContent(transformedLatestAssistant) ||
    JSON.stringify(transformedLatestAssistant.content) !==
      JSON.stringify(originalLatestAssistant.content)
  ) {
    throw new Error(
      `${label}: replay-protected latest assistant message changed during transcript sanitization`,
    );
  }
}

/**
 * Strip all `type: "thinking"` content blocks from assistant messages.
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic `{ type: "text", text: "" }` block to preserve turn structure
 * (some providers require strict user/assistant alternation).
 *
 * When `preserveLatestAssistantMessage` is enabled, the newest assistant turn
 * is left untouched so providers that require the latest assistant reasoning
 * blocks to replay verbatim still accept the conversation.
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(
  messages: AgentMessage[],
  options: DropThinkingBlocksOptions = {},
): AgentMessage[] {
  const latestAssistantIndex = options.preserveLatestAssistantMessage
    ? findLatestAssistantMessageIndex(messages)
    : -1;
  let touched = false;
  const out: AgentMessage[] = [];
  for (const [index, msg] of messages.entries()) {
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    if (index === latestAssistantIndex) {
      out.push(msg);
      continue;
    }
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    // Preserve the assistant turn even if all blocks were thinking-only.
    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}
