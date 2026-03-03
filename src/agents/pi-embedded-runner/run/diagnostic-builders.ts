import type { GenAiMessage, GenAiPart, GenAiToolDef } from "../../../infra/diagnostic-events.js";

export function buildGenAiPartsFromContent(content: unknown): GenAiPart[] {
  if (typeof content === "string") {
    return [{ type: "text", content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: GenAiPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "text", content: record.text });
      continue;
    }
    if (record.type === "image" && typeof record.data === "string") {
      parts.push({
        type: "blob",
        modality: "image",
        mime_type: typeof record.mimeType === "string" ? record.mimeType : undefined,
        content: record.data,
      });
    }
  }
  return parts;
}

export function buildGenAiMessagesFromContext(messages: unknown): GenAiMessage[] | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const out: GenAiMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const record = msg as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "";
    if (role === "user") {
      out.push({ role: "user", parts: buildGenAiPartsFromContent(record.content) });
      continue;
    }
    if (role === "assistant") {
      const parts: GenAiPart[] = [];
      const content = record.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            parts.push({ type: "text", content: b.text });
          } else if (b.type === "toolCall" || b.type === "toolUse" || b.type === "functionCall") {
            const id = typeof b.id === "string" ? b.id : "";
            const name = typeof b.name === "string" ? b.name : "";
            const args =
              b.arguments && typeof b.arguments === "object"
                ? (b.arguments as Record<string, unknown>)
                : b.input && typeof b.input === "object"
                  ? (b.input as Record<string, unknown>)
                  : undefined;
            parts.push({ type: "tool_call", id, name, arguments: args });
          }
        }
      }
      out.push({ role: "assistant", parts });
      continue;
    }
    if (role === "toolResult") {
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      // Represent tool results as a tool message with a tool_call_response part.
      out.push({
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: toolCallId,
            response: {
              toolName,
              isError: Boolean(record.isError),
              parts: buildGenAiPartsFromContent(record.content),
            },
          },
        ],
      });
    }
  }
  return out;
}

export function buildGenAiToolDefsFromContext(tools: unknown): GenAiToolDef[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const defs: GenAiToolDef[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const record = tool as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) {
      continue;
    }
    defs.push({
      name,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(record.parameters && typeof record.parameters === "object"
        ? { parameters: record.parameters as Record<string, unknown> }
        : {}),
    });
  }
  return defs.length ? defs : undefined;
}
