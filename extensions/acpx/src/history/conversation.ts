import { randomUUID } from "node:crypto";
import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import { textPrompt } from "../prompt-content.js";
import type {
  ClientOperation,
  PromptInput,
  SessionAcpxState,
  SessionConversation,
  SessionAgentContent,
  SessionAgentMessage,
  SessionMessage,
  SessionTokenUsage,
  SessionToolResult,
  SessionToolResultContent,
  SessionToolUse,
  SessionUserContent,
} from "../runtime-types.js";

export type LegacyHistoryEntry = {
  role: "user" | "assistant";
  timestamp: string;
  textPreview: string;
};

const MAX_RUNTIME_MESSAGES = 200;
const MAX_RUNTIME_AGENT_TEXT_CHARS = 8_000;
const MAX_RUNTIME_THINKING_CHARS = 4_000;
const MAX_RUNTIME_TOOL_IO_CHARS = 4_000;
const MAX_RUNTIME_REQUEST_TOKEN_USAGE = 100;

function isoNow(): string {
  return new Date().toISOString();
}

function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractText(content: ContentBlock): string | undefined {
  if (content.type === "text") {
    return content.text;
  }

  if (content.type === "resource_link") {
    return content.title ?? content.name ?? content.uri;
  }

  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return content.resource.text;
    }
    return content.resource.uri;
  }

  return undefined;
}

function contentToUserContent(content: ContentBlock): SessionUserContent | undefined {
  if (content.type === "text") {
    return {
      Text: content.text,
    };
  }

  if (content.type === "resource_link") {
    const value = content.title ?? content.name ?? content.uri;
    return {
      Mention: {
        uri: content.uri,
        content: value,
      },
    };
  }

  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return {
        Text: content.resource.text,
      };
    }

    return {
      Mention: {
        uri: content.resource.uri,
        content: content.resource.uri,
      },
    };
  }

  if (content.type === "image") {
    return {
      Image: {
        source: content.data,
        size: null,
      },
    };
  }

  return undefined;
}

function nextUserMessageId(): string {
  return randomUUID();
}

function isUserMessage(message: SessionMessage): message is {
  User: SessionConversation["messages"][number] extends infer T
    ? T extends { User: infer U }
      ? U
      : never
    : never;
} {
  return typeof message === "object" && message !== null && hasOwn(message, "User");
}

function isAgentMessage(message: SessionMessage): message is { Agent: SessionAgentMessage } {
  return typeof message === "object" && message !== null && hasOwn(message, "Agent");
}

function isAgentTextContent(content: SessionAgentContent): content is { Text: string } {
  return hasOwn(content, "Text");
}

function isAgentThinkingContent(
  content: SessionAgentContent,
): content is { Thinking: { text: string; signature?: string | null } } {
  return hasOwn(content, "Thinking");
}

function isAgentToolUseContent(
  content: SessionAgentContent,
): content is { ToolUse: SessionToolUse } {
  return hasOwn(content, "ToolUse");
}

function updateConversationTimestamp(conversation: SessionConversation, timestamp: string): void {
  conversation.updated_at = timestamp;
}

function ensureAgentMessage(conversation: SessionConversation): SessionAgentMessage {
  const last = conversation.messages.at(-1);
  if (last && isAgentMessage(last)) {
    return last.Agent;
  }

  const created: SessionAgentMessage = {
    content: [],
    tool_results: {},
  };
  conversation.messages.push({ Agent: created });
  return created;
}

function appendAgentText(agent: SessionAgentMessage, text: string): void {
  if (!text.trim()) {
    return;
  }

  const last = agent.content.at(-1);
  if (last && isAgentTextContent(last)) {
    last.Text = trimRuntimeText(`${last.Text}${text}`, MAX_RUNTIME_AGENT_TEXT_CHARS);
    return;
  }

  const next: SessionAgentContent = {
    Text: text,
  };
  agent.content.push(next);
}

function appendAgentThinking(agent: SessionAgentMessage, text: string): void {
  if (!text.trim()) {
    return;
  }

  const last = agent.content.at(-1);
  if (last && isAgentThinkingContent(last)) {
    last.Thinking.text = trimRuntimeText(
      `${last.Thinking.text}${text}`,
      MAX_RUNTIME_THINKING_CHARS,
    );
    return;
  }

  const next: SessionAgentContent = {
    Thinking: {
      text,
      signature: null,
    },
  };
  agent.content.push(next);
}

function trimRuntimeText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function statusIndicatesComplete(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return (
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized.includes("success") ||
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("cancel")
  );
}

function statusIndicatesError(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error");
}

function toToolResultContent(value: unknown): SessionToolResultContent {
  if (typeof value === "string") {
    return { Text: trimRuntimeText(value, MAX_RUNTIME_TOOL_IO_CHARS) };
  }

  if (value != null) {
    try {
      return { Text: trimRuntimeText(JSON.stringify(value), MAX_RUNTIME_TOOL_IO_CHARS) };
    } catch {
      return { Text: "[Unserializable value]" };
    }
  }

  return { Text: "" };
}

function toRawInput(value: unknown): string {
  if (typeof value === "string") {
    return trimRuntimeText(value, MAX_RUNTIME_TOOL_IO_CHARS);
  }

  try {
    return trimRuntimeText(JSON.stringify(value ?? {}), MAX_RUNTIME_TOOL_IO_CHARS);
  } catch {
    return value == null ? "" : "[Unserializable input]";
  }
}

function ensureToolUseContent(agent: SessionAgentMessage, toolCallId: string): SessionToolUse {
  for (const content of agent.content) {
    if (isAgentToolUseContent(content) && content.ToolUse.id === toolCallId) {
      return content.ToolUse;
    }
  }

  const created: SessionToolUse = {
    id: toolCallId,
    name: "tool_call",
    raw_input: "{}",
    input: {},
    is_input_complete: false,
    thought_signature: null,
  };
  agent.content.push({ ToolUse: created });
  return created;
}

function upsertToolResult(
  agent: SessionAgentMessage,
  toolCallId: string,
  patch: Partial<SessionToolResult>,
): void {
  const existing = agent.tool_results[toolCallId];
  const next: SessionToolResult = {
    tool_use_id: toolCallId,
    tool_name: patch.tool_name ?? existing?.tool_name ?? "tool_call",
    is_error: patch.is_error ?? existing?.is_error ?? false,
    content: patch.content ?? existing?.content ?? { Text: "" },
    output: patch.output ?? existing?.output,
  };
  agent.tool_results[toolCallId] = next;
}

function applyToolCallUpdate(agent: SessionAgentMessage, update: ToolCall | ToolCallUpdate): void {
  const tool = ensureToolUseContent(agent, update.toolCallId);

  if (hasOwn(update, "title")) {
    tool.name =
      normalizeAgentName((update as { title?: unknown }).title) ?? tool.name ?? "tool_call";
  }

  if (hasOwn(update, "kind")) {
    const kindName = normalizeAgentName((update as { kind?: unknown }).kind);
    if (!tool.name || tool.name === "tool_call") {
      tool.name = kindName ?? tool.name;
    }
  }

  if (hasOwn(update, "rawInput")) {
    const rawInput = deepClone((update as { rawInput?: unknown }).rawInput);
    tool.input = rawInput ?? {};
    tool.raw_input = toRawInput(rawInput);
  }

  if (hasOwn(update, "status")) {
    tool.is_input_complete = statusIndicatesComplete((update as { status?: unknown }).status);
  }

  if (
    hasOwn(update, "rawOutput") ||
    hasOwn(update, "status") ||
    hasOwn(update, "title") ||
    hasOwn(update, "kind")
  ) {
    const status = (update as { status?: unknown }).status;
    const output = hasOwn(update, "rawOutput")
      ? deepClone((update as { rawOutput?: unknown }).rawOutput)
      : undefined;

    upsertToolResult(agent, update.toolCallId, {
      tool_name: tool.name,
      is_error: statusIndicatesError(status),
      content: output === undefined ? undefined : toToolResultContent(output),
      output,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function numberField(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function usageToTokenUsage(update: UsageUpdate): SessionTokenUsage | undefined {
  const updateRecord = asRecord(update);
  const usageMeta = asRecord(updateRecord?._meta)?.usage;
  const source = asRecord(usageMeta) ?? updateRecord;
  if (!source) {
    return undefined;
  }

  const normalized: SessionTokenUsage = {
    input_tokens: numberField(source, ["input_tokens", "inputTokens"]),
    output_tokens: numberField(source, ["output_tokens", "outputTokens"]),
    cache_creation_input_tokens: numberField(source, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cachedWriteTokens",
    ]),
    cache_read_input_tokens: numberField(source, [
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cachedReadTokens",
    ]),
  };

  if (
    normalized.input_tokens === undefined &&
    normalized.output_tokens === undefined &&
    normalized.cache_creation_input_tokens === undefined &&
    normalized.cache_read_input_tokens === undefined
  ) {
    return undefined;
  }

  return normalized;
}

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

function lastUserMessageId(conversation: SessionConversation): string | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message && isUserMessage(message)) {
      return message.User.id;
    }
  }
  return undefined;
}

export function createSessionConversation(timestamp = isoNow()): SessionConversation {
  return {
    title: null,
    messages: [],
    updated_at: timestamp,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}

export function cloneSessionConversation(
  conversation: SessionConversation | undefined,
): SessionConversation {
  if (!conversation) {
    return createSessionConversation();
  }

  return {
    title: conversation.title,
    messages: deepClone(conversation.messages ?? []),
    updated_at: conversation.updated_at,
    cumulative_token_usage: deepClone(conversation.cumulative_token_usage ?? {}),
    request_token_usage: deepClone(conversation.request_token_usage ?? {}),
  };
}

export function cloneSessionAcpxState(
  state: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  if (!state) {
    return undefined;
  }

  return {
    current_mode_id: state.current_mode_id,
    desired_mode_id: state.desired_mode_id,
    current_model_id: state.current_model_id,
    available_models: state.available_models ? [...state.available_models] : undefined,
    available_commands: state.available_commands ? [...state.available_commands] : undefined,
    config_options: state.config_options ? deepClone(state.config_options) : undefined,
    session_options: state.session_options
      ? {
          model: state.session_options.model,
          allowed_tools: state.session_options.allowed_tools
            ? [...state.session_options.allowed_tools]
            : undefined,
          max_turns: state.session_options.max_turns,
        }
      : undefined,
  };
}

export function appendLegacyHistory(
  conversation: SessionConversation,
  entries: LegacyHistoryEntry[],
): void {
  for (const entry of entries) {
    const text = entry.textPreview?.trim();
    if (!text) {
      continue;
    }

    if (entry.role === "user") {
      conversation.messages.push({
        User: {
          id: nextUserMessageId(),
          content: [{ Text: text }],
        },
      });
    } else {
      conversation.messages.push({
        Agent: {
          content: [{ Text: text }],
          tool_results: {},
        },
      });
    }

    updateConversationTimestamp(conversation, entry.timestamp || conversation.updated_at);
  }
}

export function recordPromptSubmission(
  conversation: SessionConversation,
  prompt: PromptInput | string,
  timestamp = isoNow(),
): void {
  const normalizedPrompt = typeof prompt === "string" ? textPrompt(prompt) : prompt;
  const userContent = normalizedPrompt
    .map((content) => contentToUserContent(content))
    .filter((content) => content !== undefined);
  if (userContent.length === 0) {
    return;
  }

  conversation.messages.push({
    User: {
      id: nextUserMessageId(),
      content: userContent.map((content) => {
        if ("Text" in content) {
          return {
            Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS),
          };
        }
        return content;
      }),
    },
  });
  updateConversationTimestamp(conversation, timestamp);
  trimConversationForRuntime(conversation);
}

export function recordSessionUpdate(
  conversation: SessionConversation,
  state: SessionAcpxState | undefined,
  notification: SessionNotification,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = ensureAcpxState(state);

  const update: SessionUpdate = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const userContent = contentToUserContent(update.content);
      if (userContent) {
        conversation.messages.push({
          User: {
            id: nextUserMessageId(),
            content: [userContent],
          },
        });
      }
      break;
    }
    case "agent_message_chunk": {
      const text = extractText(update.content);
      if (text) {
        const agent = ensureAgentMessage(conversation);
        appendAgentText(agent, text);
      }
      break;
    }
    case "agent_thought_chunk": {
      const text = extractText(update.content);
      if (text) {
        const agent = ensureAgentMessage(conversation);
        appendAgentThinking(agent, text);
      }
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      const agent = ensureAgentMessage(conversation);
      applyToolCallUpdate(agent, update);
      break;
    }
    case "usage_update": {
      const usage = usageToTokenUsage(update);
      if (usage) {
        conversation.cumulative_token_usage = usage;
        const userId = lastUserMessageId(conversation);
        if (userId) {
          conversation.request_token_usage[userId] = usage;
        }
      }
      break;
    }
    case "session_info_update": {
      if (hasOwn(update, "title")) {
        conversation.title = update.title ?? null;
      }
      if (hasOwn(update, "updatedAt")) {
        conversation.updated_at = update.updatedAt ?? conversation.updated_at;
      }
      break;
    }
    case "available_commands_update": {
      acpx.available_commands = update.availableCommands
        .map((entry) => entry.name)
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0);
      break;
    }
    case "current_mode_update": {
      acpx.current_mode_id = update.currentModeId;
      break;
    }
    case "config_option_update": {
      acpx.config_options = deepClone(update.configOptions);
      break;
    }
    default:
      break;
  }

  updateConversationTimestamp(conversation, timestamp);
  trimConversationForRuntime(conversation);
  return acpx;
}

export function recordClientOperation(
  conversation: SessionConversation,
  state: SessionAcpxState | undefined,
  operation: ClientOperation,
  timestamp = isoNow(),
): SessionAcpxState {
  const acpx = ensureAcpxState(state);
  updateConversationTimestamp(conversation, timestamp);
  trimConversationForRuntime(conversation);
  return acpx;
}

export function trimConversationForRuntime(conversation: SessionConversation): void {
  if (conversation.messages.length > MAX_RUNTIME_MESSAGES) {
    conversation.messages = conversation.messages.slice(-MAX_RUNTIME_MESSAGES);
  }

  for (const message of conversation.messages) {
    if (!isAgentMessage(message)) {
      if (isUserMessage(message)) {
        message.User.content = message.User.content.map((content) => {
          if ("Text" in content) {
            return {
              Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS),
            };
          }
          return content;
        });
      }
      continue;
    }

    for (const content of message.Agent.content) {
      if ("Text" in content) {
        content.Text = trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS);
      } else if ("Thinking" in content) {
        content.Thinking.text = trimRuntimeText(content.Thinking.text, MAX_RUNTIME_THINKING_CHARS);
      } else if ("ToolUse" in content) {
        content.ToolUse.raw_input = trimRuntimeText(
          content.ToolUse.raw_input,
          MAX_RUNTIME_TOOL_IO_CHARS,
        );
      }
    }

    for (const result of Object.values(message.Agent.tool_results)) {
      if ("Text" in result.content) {
        result.content.Text = trimRuntimeText(result.content.Text, MAX_RUNTIME_TOOL_IO_CHARS);
      }
      if (typeof result.output === "string") {
        result.output = trimRuntimeText(result.output, MAX_RUNTIME_TOOL_IO_CHARS);
      }
    }
  }

  const requestUsageEntries = Object.entries(conversation.request_token_usage);
  if (requestUsageEntries.length > MAX_RUNTIME_REQUEST_TOKEN_USAGE) {
    conversation.request_token_usage = Object.fromEntries(
      requestUsageEntries.slice(-MAX_RUNTIME_REQUEST_TOKEN_USAGE),
    );
  }
}
