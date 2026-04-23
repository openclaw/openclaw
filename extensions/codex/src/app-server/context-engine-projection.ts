import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type CodexContextProjection = {
  developerInstructionAddition?: string;
  promptText: string;
  assembledMessages: AgentMessage[];
  prePromptMessageCount: number;
};

const CONTEXT_HEADER = "OpenClaw assembled context for this turn:";
const CONTEXT_OPEN = "<conversation_context>";
const CONTEXT_CLOSE = "</conversation_context>";
const REQUEST_HEADER = "Current user request:";

/**
 * Project assembled OpenClaw context-engine messages into Codex prompt inputs.
 */
export function projectContextEngineAssemblyForCodex(params: {
  assembledMessages: AgentMessage[];
  originalHistoryMessages: AgentMessage[];
  prompt: string;
  systemPromptAddition?: string;
}): CodexContextProjection {
  const prompt = params.prompt.trim();
  const contextMessages = dropDuplicateTrailingPrompt(params.assembledMessages, prompt);
  const renderedContext = renderMessagesForCodexContext(contextMessages);
  const promptText = renderedContext
    ? [
        CONTEXT_HEADER,
        "",
        CONTEXT_OPEN,
        renderedContext,
        CONTEXT_CLOSE,
        "",
        REQUEST_HEADER,
        prompt,
      ].join("\n")
    : prompt;

  return {
    ...(params.systemPromptAddition?.trim()
      ? { developerInstructionAddition: params.systemPromptAddition.trim() }
      : {}),
    promptText,
    assembledMessages: params.assembledMessages,
    prePromptMessageCount: params.originalHistoryMessages.length,
  };
}

function dropDuplicateTrailingPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  if (!prompt) {
    return messages;
  }
  const trailing = messages.at(-1);
  if (!trailing || trailing.role !== "user") {
    return messages;
  }
  return extractMessageText(trailing).trim() === prompt ? messages.slice(0, -1) : messages;
}

function renderMessagesForCodexContext(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      const text = renderMessageBody(message);
      return text ? `[${message.role}]\n${text}` : undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function renderMessageBody(message: AgentMessage): string {
  if (!hasMessageContent(message)) {
    return stableStringify(message);
  }
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return stableStringify(message.content);
  }
  return message.content
    .map((part: unknown) => renderMessagePart(part))
    .filter((value): value is string => value.length > 0)
    .join("\n")
    .trim();
}

function renderMessagePart(part: unknown): string {
  if (!part || typeof part !== "object") {
    return stableStringify(part);
  }
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type === "text") {
    return typeof record.text === "string" ? record.text.trim() : "";
  }
  if (type === "image") {
    return "[image omitted]";
  }
  if (type === "toolCall" || type === "tool_use") {
    return renderLabeledJson(
      `tool call${typeof record.name === "string" ? `: ${record.name}` : ""}`,
      {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...("arguments" in record ? { arguments: record.arguments } : {}),
        ...("input" in record ? { input: record.input } : {}),
      },
    );
  }
  if (type === "toolResult" || type === "tool_result") {
    const content = Array.isArray(record.content)
      ? record.content
          .map((child) => renderMessagePart(child))
          .filter(Boolean)
          .join("\n")
      : stableStringify(record.content);
    const label =
      typeof record.toolUseId === "string" ? `tool result: ${record.toolUseId}` : "tool result";
    return content ? `${label}\n${content}` : label;
  }
  return renderLabeledJson(type ?? "content", record);
}

function renderLabeledJson(label: string, value: unknown): string {
  return `${label}\n${stableStringify(value)}`;
}

function extractMessageText(message: AgentMessage): string {
  if (!hasMessageContent(message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object" || !("type" in part)) {
        return [];
      }
      const record = part as Record<string, unknown>;
      return record.type === "text" ? [typeof record.text === "string" ? record.text : ""] : [];
    })
    .join("\n");
}

function hasMessageContent(message: AgentMessage): message is AgentMessage & { content: unknown } {
  return "content" in message;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(stabilizeJson(value), null, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function stabilizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stabilizeJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stabilizeJson(child)]),
  );
}
