import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  StopReason,
  Tool,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { GenerativeAiInferenceClient } from "oci-generativeaiinference";
import {
  createOracleAuthenticationDetailsProvider,
  parseOracleRuntimeAuthToken,
  resolveOracleAuth,
  resolveStoredOracleAuth,
  type OracleResolvedAuth,
} from "./oci-auth.js";

type OracleMessageRole = "SYSTEM" | "USER" | "ASSISTANT" | "TOOL";

type OracleTextBlock = {
  type: "TEXT";
  text: string;
};

type OracleFunctionCall = {
  id: string;
  type: "FUNCTION";
  name?: string;
  arguments?: string;
};

type OracleMessage = {
  role: OracleMessageRole;
  content?: OracleTextBlock[];
  toolCallId?: string;
  toolCalls?: OracleFunctionCall[];
};

type OracleToolDefinition = {
  type: "FUNCTION";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

type OracleUsageShape = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

type OracleChatChoice = {
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    toolCalls?: Array<{
      id?: string;
      type?: string;
      name?: string;
      arguments?: string;
    }>;
  };
  finishReason?: string;
  usage?: OracleUsageShape;
};

type OracleChatResponseShape = {
  usage?: OracleUsageShape;
  choices?: OracleChatChoice[];
};

type OracleChatResultShape = {
  modelId?: string;
  chatResponse?: OracleChatResponseShape;
};

type OracleChatResponseEnvelope = {
  chatResult?: OracleChatResultShape;
};

type OracleInferenceClient = Pick<GenerativeAiInferenceClient, "chat" | "close">;

type CreateOracleClient = (auth: OracleResolvedAuth) => OracleInferenceClient;

const ORACLE_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const ORACLE_SCHEMA_META_KEYS = ["description", "title", "default"] as const;

function buildZeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function buildUsage(usage?: OracleUsageShape): Usage {
  const input = usage?.promptTokens ?? 0;
  const output = usage?.completionTokens ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage?.totalTokens ?? input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function copyOracleSchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of ORACLE_SCHEMA_META_KEYS) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
}

function extendOracleSchemaDefs(
  defs: Map<string, unknown> | undefined,
  schema: Record<string, unknown>,
): Map<string, unknown> | undefined {
  const defsEntry =
    schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : undefined;
  const legacyDefsEntry =
    schema.definitions &&
    typeof schema.definitions === "object" &&
    !Array.isArray(schema.definitions)
      ? (schema.definitions as Record<string, unknown>)
      : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next = defs ? new Map(defs) : new Map<string, unknown>();
  if (defsEntry) {
    for (const [key, value] of Object.entries(defsEntry)) {
      next.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of Object.entries(legacyDefsEntry)) {
      next.set(key, value);
    }
  }
  return next;
}

function decodeOracleJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function tryResolveOracleLocalRef(ref: string, defs: Map<string, unknown> | undefined): unknown {
  if (!defs) {
    return undefined;
  }
  const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const name = decodeOracleJsonPointerSegment(match[1] ?? "");
  if (!name) {
    return undefined;
  }
  return defs.get(name);
}

function tryFlattenOracleLiteralAnyOf(
  variants: unknown[],
): { type: string; enum: unknown[] } | null {
  if (variants.length === 0) {
    return null;
  }

  const values: unknown[] = [];
  let commonType: string | null = null;

  for (const variant of variants) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      return null;
    }

    const record = variant as Record<string, unknown>;
    let literalValue: unknown;
    if ("const" in record) {
      literalValue = record.const;
    } else if (Array.isArray(record.enum) && record.enum.length === 1) {
      literalValue = record.enum[0];
    } else {
      return null;
    }

    const variantType = typeof record.type === "string" ? record.type : null;
    if (!variantType) {
      return null;
    }

    if (commonType === null) {
      commonType = variantType;
    } else if (commonType !== variantType) {
      return null;
    }

    values.push(literalValue);
  }

  return commonType ? { type: commonType, enum: values } : null;
}

function isOracleNullSchema(variant: unknown): boolean {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    return false;
  }
  const record = variant as Record<string, unknown>;
  if ("const" in record && record.const === null) {
    return true;
  }
  if (Array.isArray(record.enum) && record.enum.length === 1) {
    return record.enum[0] === null;
  }
  const typeValue = record.type;
  if (typeValue === "null") {
    return true;
  }
  return Array.isArray(typeValue) && typeValue.length === 1 && typeValue[0] === "null";
}

function stripOracleNullVariants(variants: unknown[]): {
  variants: unknown[];
  stripped: boolean;
} {
  const nonNull = variants.filter((variant) => !isOracleNullSchema(variant));
  return {
    variants: nonNull,
    stripped: nonNull.length !== variants.length,
  };
}

function simplifyOracleUnionVariants(params: {
  obj: Record<string, unknown>;
  variants: unknown[];
}): { variants: unknown[]; simplified?: unknown } {
  const { obj, variants } = params;
  const { variants: nonNullVariants, stripped } = stripOracleNullVariants(variants);

  const flattened = tryFlattenOracleLiteralAnyOf(nonNullVariants);
  if (flattened) {
    const result: Record<string, unknown> = {
      type: flattened.type,
      enum: flattened.enum,
    };
    copyOracleSchemaMeta(obj, result);
    return { variants: nonNullVariants, simplified: result };
  }

  if (stripped && nonNullVariants.length === 1) {
    const lone = nonNullVariants[0];
    if (lone && typeof lone === "object" && !Array.isArray(lone)) {
      const result = { ...(lone as Record<string, unknown>) };
      copyOracleSchemaMeta(obj, result);
      return { variants: nonNullVariants, simplified: result };
    }
    return { variants: nonNullVariants, simplified: lone };
  }

  return { variants: stripped ? nonNullVariants : variants };
}

function flattenOracleUnionFallback(
  obj: Record<string, unknown>,
  variants: unknown[],
): Record<string, unknown> | undefined {
  const objects = variants.filter(
    (variant): variant is Record<string, unknown> =>
      Boolean(variant) && typeof variant === "object" && !Array.isArray(variant),
  );
  if (objects.length === 0) {
    return undefined;
  }

  const types = new Set(objects.map((variant) => variant.type).filter(Boolean));
  if (objects.length === 1) {
    const result = { ...objects[0] };
    copyOracleSchemaMeta(obj, result);
    return result;
  }
  if (types.size === 1) {
    const result: Record<string, unknown> = { type: Array.from(types)[0] };
    copyOracleSchemaMeta(obj, result);
    return result;
  }

  const first = objects[0];
  if (first?.type) {
    const result: Record<string, unknown> = { type: first.type };
    copyOracleSchemaMeta(obj, result);
    return result;
  }

  const result: Record<string, unknown> = {};
  copyOracleSchemaMeta(obj, result);
  return result;
}

function cleanSchemaForOracleWithDefs(
  schema: unknown,
  defs: Map<string, unknown> | undefined,
  refStack: Set<string> | undefined,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanSchemaForOracleWithDefs(item, defs, refStack));
  }

  const record = schema as Record<string, unknown>;
  const nextDefs = extendOracleSchemaDefs(defs, record);

  const refValue = typeof record.$ref === "string" ? record.$ref : undefined;
  if (refValue) {
    if (refStack?.has(refValue)) {
      return {};
    }

    const resolved = tryResolveOracleLocalRef(refValue, nextDefs);
    if (resolved) {
      const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
      nextRefStack.add(refValue);

      const cleanedResolved = cleanSchemaForOracleWithDefs(resolved, nextDefs, nextRefStack);
      if (
        !cleanedResolved ||
        typeof cleanedResolved !== "object" ||
        Array.isArray(cleanedResolved)
      ) {
        return cleanedResolved;
      }

      const result = { ...(cleanedResolved as Record<string, unknown>) };
      copyOracleSchemaMeta(record, result);
      return result;
    }

    const result: Record<string, unknown> = {};
    copyOracleSchemaMeta(record, result);
    return result;
  }

  const hasAnyOf = Array.isArray(record.anyOf);
  const hasOneOf = Array.isArray(record.oneOf);

  let cleanedAnyOf = hasAnyOf
    ? (record.anyOf as unknown[]).map((variant) =>
        cleanSchemaForOracleWithDefs(variant, nextDefs, refStack),
      )
    : undefined;
  let cleanedOneOf = hasOneOf
    ? (record.oneOf as unknown[]).map((variant) =>
        cleanSchemaForOracleWithDefs(variant, nextDefs, refStack),
      )
    : undefined;

  if (cleanedAnyOf) {
    const simplified = simplifyOracleUnionVariants({ obj: record, variants: cleanedAnyOf });
    if (simplified.simplified !== undefined) {
      return simplified.simplified;
    }
    cleanedAnyOf = simplified.variants;
  }

  if (cleanedOneOf) {
    const simplified = simplifyOracleUnionVariants({ obj: record, variants: cleanedOneOf });
    if (simplified.simplified !== undefined) {
      return simplified.simplified;
    }
    cleanedOneOf = simplified.variants;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ORACLE_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    if (key === "const") {
      cleaned.enum = [value];
      continue;
    }

    if (key === "type" && (hasAnyOf || hasOneOf)) {
      continue;
    }
    if (
      key === "type" &&
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const types = value.filter((entry) => entry !== "null");
      cleaned.type = types.length === 1 ? types[0] : types;
      continue;
    }

    if (key === "properties") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        cleaned.properties = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([propertyName, propertyValue]) => [
            propertyName,
            cleanSchemaForOracleWithDefs(propertyValue, nextDefs, refStack),
          ]),
        );
      } else {
        cleaned.properties = {};
      }
      continue;
    }

    if (key === "items" && value) {
      if (Array.isArray(value)) {
        cleaned.items = value.map((entry) =>
          cleanSchemaForOracleWithDefs(entry, nextDefs, refStack),
        );
      } else if (typeof value === "object") {
        cleaned.items = cleanSchemaForOracleWithDefs(value, nextDefs, refStack);
      } else {
        cleaned.items = value;
      }
      continue;
    }

    if (key === "anyOf" && Array.isArray(value)) {
      cleaned.anyOf =
        cleanedAnyOf ??
        value.map((variant) => cleanSchemaForOracleWithDefs(variant, nextDefs, refStack));
      continue;
    }

    if (key === "oneOf" && Array.isArray(value)) {
      cleaned.oneOf =
        cleanedOneOf ??
        value.map((variant) => cleanSchemaForOracleWithDefs(variant, nextDefs, refStack));
      continue;
    }

    if (key === "allOf" && Array.isArray(value)) {
      cleaned.allOf = value.map((variant) =>
        cleanSchemaForOracleWithDefs(variant, nextDefs, refStack),
      );
      continue;
    }

    cleaned[key] = value;
  }

  if (Array.isArray(cleaned.anyOf)) {
    return flattenOracleUnionFallback(cleaned, cleaned.anyOf) ?? cleaned;
  }
  if (Array.isArray(cleaned.oneOf)) {
    return flattenOracleUnionFallback(cleaned, cleaned.oneOf) ?? cleaned;
  }

  return cleaned;
}

function normalizeOracleToolParameters(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return {};
  }

  const defs = extendOracleSchemaDefs(undefined, parameters as Record<string, unknown>);
  const cleaned = cleanSchemaForOracleWithDefs(parameters, defs, undefined);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return {};
  }

  const record = cleaned as Record<string, unknown>;
  if (
    !("type" in record) &&
    (typeof record.properties === "object" || Array.isArray(record.required)) &&
    !Array.isArray(record.anyOf) &&
    !Array.isArray(record.oneOf)
  ) {
    return { ...record, type: "object" };
  }
  return record;
}

function buildAssistantMessage(params: {
  model: { api: string; provider: string; id: string };
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: Date.now(),
  };
}

function buildErrorAssistantMessage(params: {
  model: { api: string; provider: string; id: string };
  errorMessage: string;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMessage({
      model: params.model,
      content: [],
      stopReason: "error",
      usage: buildZeroUsage(),
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}

function toTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return content ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const block of content as Array<{
    type?: string;
    text?: string;
  }>) {
    if (
      (block.type === "text" || block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image" || block.type === "input_image") {
      parts.push("[Image omitted]");
    }
  }
  return parts;
}

function toOracleTextBlocks(content: unknown): OracleTextBlock[] | undefined {
  const text = toTextParts(content).join("\n").trim();
  return text ? [{ type: "TEXT", text }] : undefined;
}

function isOracleToolUseBlockType(type: unknown): type is "toolUse" | "tool_use" {
  return type === "toolUse" || type === "tool_use";
}

function isOracleToolCallBlockType(
  type: unknown,
): type is "functionCall" | "function_call" | "toolCall" | "tool_call" | "toolUse" | "tool_use" {
  return (
    type === "functionCall" ||
    type === "function_call" ||
    type === "toolCall" ||
    type === "tool_call" ||
    isOracleToolUseBlockType(type)
  );
}

function toOracleToolCalls(content: unknown): OracleFunctionCall[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const toolCalls: OracleFunctionCall[] = [];
  for (const block of content as Array<{
    type?: string;
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
  }>) {
    if (!isOracleToolCallBlockType(block.type)) {
      continue;
    }

    const id =
      typeof block.id === "string" && block.id.trim().length > 0
        ? block.id
        : `oracle_call_${randomUUID()}`;
    const name =
      typeof block.name === "string" && block.name.trim().length > 0
        ? block.name.trim()
        : undefined;
    const rawArguments = isOracleToolUseBlockType(block.type) ? block.input : block.arguments;
    const argumentsText =
      typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments ?? {});

    toolCalls.push({
      id,
      type: "FUNCTION",
      ...(name ? { name } : {}),
      arguments: argumentsText,
    });
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function toOracleToolCallId(message: Message): string | undefined {
  const withIds = message as Message & {
    toolCallId?: unknown;
    toolUseId?: unknown;
    tool_call_id?: unknown;
    tool_use_id?: unknown;
  };
  if (typeof withIds.toolCallId === "string" && withIds.toolCallId.trim().length > 0) {
    return withIds.toolCallId;
  }
  if (typeof withIds.toolUseId === "string" && withIds.toolUseId.trim().length > 0) {
    return withIds.toolUseId;
  }
  if (typeof withIds.tool_call_id === "string" && withIds.tool_call_id.trim().length > 0) {
    return withIds.tool_call_id;
  }
  if (typeof withIds.tool_use_id === "string" && withIds.tool_use_id.trim().length > 0) {
    return withIds.tool_use_id;
  }
  return undefined;
}

function isOracleGeminiModelId(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith("google.gemini-");
}

function isOracleToolOutputMessage(message: Message | undefined): message is Message {
  const role = (message as { role?: unknown } | undefined)?.role;
  return role === "tool" || role === "toolResult";
}

function toOracleToolMessage(message: Message): OracleMessage | undefined {
  const toolCallId = toOracleToolCallId(message);
  const content = toOracleTextBlocks(message.content);
  if (!toolCallId && !content) {
    return undefined;
  }

  return {
    role: "TOOL",
    ...(toolCallId ? { toolCallId } : {}),
    ...(content ? { content } : {}),
  };
}

function tryConvertGeminiAssistantToolSequence(params: {
  messages: Message[];
  startIndex: number;
  assistantContent: OracleTextBlock[] | undefined;
  assistantToolCalls: OracleFunctionCall[];
}): { messages: OracleMessage[]; nextIndex: number } | undefined {
  if (params.assistantToolCalls.length < 2) {
    return undefined;
  }

  const followingToolResults: Message[] = [];
  let nextIndex = params.startIndex + 1;
  while (
    nextIndex < params.messages.length &&
    isOracleToolOutputMessage(params.messages[nextIndex] as Message | undefined)
  ) {
    followingToolResults.push(params.messages[nextIndex] as Message);
    nextIndex += 1;
  }

  if (followingToolResults.length !== params.assistantToolCalls.length) {
    return undefined;
  }

  const toolResultsById = new Map<string, Message>();
  for (const toolResult of followingToolResults) {
    const toolCallId = toOracleToolCallId(toolResult);
    if (!toolCallId || toolResultsById.has(toolCallId)) {
      return undefined;
    }
    toolResultsById.set(toolCallId, toolResult);
  }

  const oracleMessages: OracleMessage[] = [];
  for (const [index, toolCall] of params.assistantToolCalls.entries()) {
    const toolResult = toolResultsById.get(toolCall.id);
    if (!toolResult) {
      return undefined;
    }

    const assistantMessage: OracleMessage = {
      role: "ASSISTANT",
      ...(index === 0 && params.assistantContent ? { content: params.assistantContent } : {}),
      toolCalls: [toolCall],
    };
    oracleMessages.push(assistantMessage);

    const oracleToolMessage = toOracleToolMessage(toolResult);
    if (!oracleToolMessage) {
      return undefined;
    }
    oracleMessages.push(oracleToolMessage);
  }

  return { messages: oracleMessages, nextIndex };
}

export function convertPiMessagesToOracleMessages(params: {
  systemPrompt?: string;
  messages: Message[];
  modelId?: string;
}): OracleMessage[] {
  const oracleMessages: OracleMessage[] = [];
  const useGeminiToolPairing = isOracleGeminiModelId(params.modelId);

  if (params.systemPrompt?.trim()) {
    oracleMessages.push({
      role: "SYSTEM",
      content: [{ type: "TEXT", text: params.systemPrompt.trim() }],
    });
  }

  for (let index = 0; index < params.messages.length; index += 1) {
    const message = params.messages[index] as Message;
    if (message.role === "user") {
      const content = toOracleTextBlocks(message.content);
      if (content) {
        oracleMessages.push({ role: "USER", content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = toOracleTextBlocks(message.content);
      const toolCalls = toOracleToolCalls(message.content);
      if (useGeminiToolPairing && toolCalls) {
        const pairedSequence = tryConvertGeminiAssistantToolSequence({
          messages: params.messages,
          startIndex: index,
          assistantContent: content,
          assistantToolCalls: toolCalls,
        });
        if (pairedSequence) {
          oracleMessages.push(...pairedSequence.messages);
          index = pairedSequence.nextIndex - 1;
          continue;
        }
      }
      if (content || toolCalls) {
        oracleMessages.push({
          role: "ASSISTANT",
          ...(content ? { content } : {}),
          ...(toolCalls ? { toolCalls } : {}),
        });
      }
      continue;
    }

    if (!isOracleToolOutputMessage(message)) {
      continue;
    }

    const oracleToolMessage = toOracleToolMessage(message);
    if (oracleToolMessage) {
      oracleMessages.push(oracleToolMessage);
    }
  }

  return oracleMessages;
}

function convertTools(tools: Tool[] | undefined): OracleToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted = tools
    .filter((tool) => typeof tool.name === "string" && tool.name.trim().length > 0)
    .map((tool) => ({
      type: "FUNCTION" as const,
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      // OCI's tool validator rejects several JSON Schema keywords that OpenClaw
      // tool definitions commonly include, such as patternProperties.
      parameters: normalizeOracleToolParameters(tool.parameters),
    }));

  return converted.length > 0 ? converted : undefined;
}

function extractOracleText(
  content: Array<{ type?: string; text?: string }> | undefined,
): string | undefined {
  const text = (content ?? [])
    .filter((block) => block.type === "TEXT" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  return text.trim() ? text : undefined;
}

function parseToolArguments(argumentsText: string | undefined): Record<string, unknown> {
  if (!argumentsText) {
    return {};
  }
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { raw: argumentsText };
  }
  return {};
}

export function convertOracleChatResultToAssistantMessage(
  chatResult: OracleChatResultShape,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  const response = chatResult.chatResponse;
  const choice = response?.choices?.[0];
  const assistantMessage = choice?.message;
  const assistantText = extractOracleText(assistantMessage?.content);
  const toolCalls = assistantMessage?.toolCalls ?? [];

  const content: Array<{ type: "text"; text: string } | ToolCall> = [];
  if (assistantText) {
    content.push({ type: "text", text: assistantText });
  }

  for (const toolCall of toolCalls) {
    const name = typeof toolCall.name === "string" && toolCall.name.trim() ? toolCall.name : "tool";
    content.push({
      type: "toolCall",
      id:
        typeof toolCall.id === "string" && toolCall.id.trim().length > 0
          ? toolCall.id
          : `oracle_call_${randomUUID()}`,
      name,
      arguments: parseToolArguments(toolCall.arguments),
    });
  }

  const stopReason: StopReason =
    toolCalls.length > 0 ? "toolUse" : choice?.finishReason === "LENGTH" ? "length" : "stop";

  return buildAssistantMessage({
    model,
    content,
    stopReason,
    usage: buildUsage(choice?.usage ?? response?.usage),
  });
}

function createDefaultOracleInferenceClient(auth: OracleResolvedAuth): OracleInferenceClient {
  const authenticationDetailsProvider = createOracleAuthenticationDetailsProvider({
    configFile: auth.configFile,
    profile: auth.profile,
  });
  return new GenerativeAiInferenceClient({ authenticationDetailsProvider });
}

function resolveOracleStreamAuth(params: {
  agentDir?: string;
  options:
    | {
        apiKey?: string;
      }
    | null
    | undefined;
}): OracleResolvedAuth {
  const runtimeApiKey =
    typeof params.options?.apiKey === "string" ? params.options.apiKey.trim() : "";
  const storedAuth = resolveStoredOracleAuth({ agentDir: params.agentDir });
  if (!runtimeApiKey) {
    if (storedAuth) {
      return storedAuth;
    }
    return resolveOracleAuth({ env: process.env });
  }

  try {
    return parseOracleRuntimeAuthToken(runtimeApiKey);
  } catch {
    // Simple-completion and older/custom call paths can still pass the source
    // OCI config path instead of the runtime token. When we have the stored
    // Oracle profile, prefer it so profile/compartment stay explicit.
    if (storedAuth && storedAuth.configFile === path.resolve(runtimeApiKey)) {
      return storedAuth;
    }
    return resolveOracleAuth({
      env: process.env,
      configFile: runtimeApiKey,
    });
  }
}

export function createOracleStreamFn(
  params?: CreateOracleClient | { agentDir?: string; createClient?: CreateOracleClient },
): StreamFn {
  const createClient =
    typeof params === "function"
      ? params
      : (params?.createClient ?? createDefaultOracleInferenceClient);
  const agentDir = typeof params === "function" ? undefined : params?.agentDir;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      let client: OracleInferenceClient | undefined;
      try {
        const auth = resolveOracleStreamAuth({ agentDir, options });
        client = createClient(auth);
        const tools = convertTools(context.tools);
        const providerOptions = (options ?? {}) as Record<string, unknown>;
        const response = (await client.chat({
          chatDetails: {
            compartmentId: auth.compartmentId,
            servingMode: {
              servingType: "ON_DEMAND",
              modelId: model.id,
            },
            chatRequest: {
              apiFormat: "GENERIC",
              isStream: false,
              messages: convertPiMessagesToOracleMessages({
                systemPrompt: context.systemPrompt,
                messages: context.messages,
                modelId: model.id,
              }),
              ...(typeof options?.temperature === "number"
                ? { temperature: options.temperature }
                : {}),
              ...(typeof providerOptions.topP === "number" ? { topP: providerOptions.topP } : {}),
              ...(typeof options?.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
              ...(tools ? { tools } : {}),
            },
          },
        })) as OracleChatResponseEnvelope | null;

        const chatResult = response?.chatResult;
        if (!chatResult?.chatResponse) {
          throw new Error("Oracle OCI returned an empty chat response.");
        }

        const assistantMessage = convertOracleChatResultToAssistantMessage(chatResult, {
          api: model.api,
          provider: model.provider,
          id: model.id,
        });

        const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          assistantMessage.stopReason === "toolUse"
            ? "toolUse"
            : assistantMessage.stopReason === "length"
              ? "length"
              : "stop";

        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({
          type: "error",
          reason: "error",
          error: buildErrorAssistantMessage({
            model: {
              api: model.api,
              provider: model.provider,
              id: model.id,
            },
            errorMessage,
          }),
        });
      } finally {
        try {
          client?.close();
        } catch {
          // Best-effort cleanup only.
        }
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
