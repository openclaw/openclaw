import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readFunctionName(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }
  const fn = tool.function;
  if (isRecord(fn) && typeof fn.name === "string" && fn.name.trim()) {
    return fn.name.trim();
  }
  if (typeof tool.name === "string" && tool.name.trim()) {
    return tool.name.trim();
  }
  return undefined;
}

function normalizeToolParameters(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function convertOpenAIToolToGigachatFunction(tool: unknown): JsonRecord | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }
  if (tool.type !== undefined && tool.type !== "function") {
    return undefined;
  }
  const fn = isRecord(tool.function) ? tool.function : tool;
  const name = readFunctionName(tool);
  if (!name) {
    return undefined;
  }
  const description = typeof fn.description === "string" ? fn.description : undefined;
  return {
    name,
    ...(description ? { description } : {}),
    parameters: normalizeToolParameters(fn.parameters),
  };
}

function convertToolChoice(value: unknown): unknown {
  if (value === "auto" || value === "none") {
    return value;
  }
  if (value === "required") {
    return "auto";
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const functionName = isRecord(value.function) ? value.function.name : value.name;
  return typeof functionName === "string" && functionName.trim()
    ? { name: functionName.trim() }
    : undefined;
}

function parseToolArguments(value: unknown): JsonRecord {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFunctionResultContent(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) {
        return JSON.stringify(parsed);
      }
    } catch {
      // Fall through and wrap plain text as a JSON object for GigaChat.
    }
    return JSON.stringify({ result: value });
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return JSON.stringify({ result: value ?? "" });
}

function buildToolCallNameById(messages: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== "string") {
        continue;
      }
      const name = readFunctionName(call);
      if (name) {
        names.set(call.id, name);
      }
    }
  }
  return names;
}

function convertAssistantToolCallMessage(message: JsonRecord): JsonRecord {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const firstCall = toolCalls.find((call): call is JsonRecord => isRecord(call));
  if (!firstCall) {
    return message;
  }
  const name = readFunctionName(firstCall);
  if (!name) {
    return message;
  }
  const fn = isRecord(firstCall.function) ? firstCall.function : firstCall;
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    function_call: {
      name,
      arguments: parseToolArguments(fn.arguments),
    },
    ...(typeof message.functions_state_id === "string"
      ? { functions_state_id: message.functions_state_id }
      : {}),
  };
}

function convertToolResultMessage(
  message: JsonRecord,
  toolCallNameById: Map<string, string>,
): JsonRecord {
  const name =
    (typeof message.name === "string" && message.name.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_call_id === "string"
      ? toolCallNameById.get(message.tool_call_id)
      : undefined) ||
    (typeof message.toolCallId === "string" ? toolCallNameById.get(message.toolCallId) : undefined);
  return {
    role: "function",
    content: normalizeFunctionResultContent(message.content),
    ...(name ? { name } : {}),
  };
}

function sanitizeRegularMessage(message: JsonRecord): JsonRecord {
  const next: JsonRecord = {};
  if (Object.prototype.hasOwnProperty.call(message, "role")) {
    next.role = message.role;
  }
  if (Object.prototype.hasOwnProperty.call(message, "content")) {
    next.content = message.content;
  }
  if (typeof message.name === "string" && message.name.trim()) {
    next.name = message.name.trim();
  }
  if (isRecord(message.function_call)) {
    const name =
      typeof message.function_call.name === "string" ? message.function_call.name.trim() : "";
    if (name) {
      next.function_call = {
        name,
        arguments: parseToolArguments(message.function_call.arguments),
      };
    }
  }
  if (typeof message.functions_state_id === "string") {
    next.functions_state_id = message.functions_state_id;
  }
  return next;
}

export function normalizeGigachatToolPayload(payload: JsonRecord): void {
  if (Array.isArray(payload.tools)) {
    const functions = payload.tools
      .map(convertOpenAIToolToGigachatFunction)
      .filter((tool): tool is JsonRecord => Boolean(tool));
    if (functions.length > 0) {
      payload.functions = functions;
      const functionCall = convertToolChoice(payload.tool_choice);
      if (functionCall !== undefined) {
        payload.function_call = functionCall;
      }
    }
    delete payload.tools;
  }
  delete payload.tool_choice;
  delete payload.parallel_tool_calls;

  if (!Array.isArray(payload.messages)) {
    return;
  }
  const toolCallNameById = buildToolCallNameById(payload.messages);
  payload.messages = payload.messages.map((message) => {
    if (!isRecord(message)) {
      return message;
    }
    if (Array.isArray(message.tool_calls)) {
      return convertAssistantToolCallMessage(message);
    }
    if (message.role === "tool") {
      return convertToolResultMessage(message, toolCallNameById);
    }
    return sanitizeRegularMessage(message);
  });
}

export function wrapGigachatProviderStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, normalizeGigachatToolPayload);
}
