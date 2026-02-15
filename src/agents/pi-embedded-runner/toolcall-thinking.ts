function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * Strip thinking from assistant messages that also include tool calls.
 *
 * Some OpenAI-compatible APIs reject assistant messages that include both `content`
 * and `thinking` when tool calls are present (pi-ai surfaces this as a template error).
 *
 * Returns the original context object when no changes are needed.
 *
 * @internal Exported for testing
 */
export function stripThinkingFromAssistantToolCallMessages(context: unknown): unknown {
  if (!isRecord(context)) {
    return context;
  }

  const rawMessages = context.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return context;
  }

  let changed = false;
  const nextMessages = rawMessages.map((msg) => {
    if (!isRecord(msg) || msg.role !== "assistant") {
      return msg;
    }

    const rawContent = msg.content;
    if (!Array.isArray(rawContent) || rawContent.length === 0) {
      return msg;
    }

    const hasToolCall = rawContent.some((block) => isRecord(block) && block.type === "toolCall");
    if (!hasToolCall) {
      return msg;
    }

    const hasThinkingBlock = rawContent.some(
      (block) => isRecord(block) && block.type === "thinking",
    );
    const hasThinkingProp = "thinking" in msg && Boolean(msg.thinking);
    if (!hasThinkingBlock && !hasThinkingProp) {
      return msg;
    }

    changed = true;
    const nextMsg: Record<string, unknown> = { ...msg };
    nextMsg.content = rawContent.filter((block) => !(isRecord(block) && block.type === "thinking"));
    if ("thinking" in nextMsg) {
      delete nextMsg.thinking;
    }
    return nextMsg;
  });

  if (!changed) {
    return context;
  }

  return {
    ...context,
    messages: nextMessages,
  };
}
