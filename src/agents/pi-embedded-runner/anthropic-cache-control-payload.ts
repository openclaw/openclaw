export function applyAnthropicEphemeralCacheControlMarkers(
  payloadObj: Record<string, unknown>,
): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") {
        message.content = [
          { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
        ];
        continue;
      }
      if (Array.isArray(message.content) && message.content.length > 0) {
        const last = message.content[message.content.length - 1];
        if (last && typeof last === "object") {
          const record = last as Record<string, unknown>;
          if (record.type !== "thinking" && record.type !== "redacted_thinking") {
            record.cache_control = { type: "ephemeral" };
          }
        }
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const record = block as Record<string, unknown>;
        if (record.type === "thinking" || record.type === "redacted_thinking") {
          delete record.cache_control;
        }
      }
    }
  }
}
