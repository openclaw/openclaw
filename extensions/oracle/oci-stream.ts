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
import {
  resolveOracleModelRouting,
  type OracleChatApiFormat,
  type OracleOutputTokenField,
} from "./oci-routing.js";

type OracleMessageRole = "SYSTEM" | "USER" | "ASSISTANT" | "TOOL";

type OracleTextBlock = {
  type: "TEXT";
  text: string;
};

type OracleCohereToolParameterDefinition = {
  type: string;
  description?: string;
  isRequired?: boolean;
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

type OracleCohereToolDefinition = {
  name: string;
  description: string;
  parameterDefinitions?: Record<string, OracleCohereToolParameterDefinition>;
};

type OracleCohereToolCall = {
  name: string;
  parameters: Record<string, unknown>;
};

type OracleCohereToolResult = {
  call: OracleCohereToolCall;
  outputs: Array<Record<string, unknown>>;
};

type OracleCohereChatHistoryMessage =
  | { role: "SYSTEM"; message: string }
  | { role: "USER"; message: string }
  | { role: "CHATBOT"; message?: string; toolCalls?: OracleCohereToolCall[] }
  | { role: "TOOL"; toolResults: OracleCohereToolResult[] };

type OracleCohereChatRequestShape = {
  apiFormat: "COHERE";
  message: string;
  chatHistory?: OracleCohereChatHistoryMessage[];
  tools?: OracleCohereToolDefinition[];
  toolResults?: OracleCohereToolResult[];
  preambleOverride?: string;
  isStream: false;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
};

type OracleCohereV2ToolFunction = {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  arguments?: string;
};

type OracleCohereV2ToolDefinition = {
  type: "FUNCTION";
  function: OracleCohereV2ToolFunction;
};

type OracleCohereV2ToolCall = {
  id?: string;
  type?: "FUNCTION";
  function?: OracleCohereV2ToolFunction;
};

type OracleCohereV2Message = {
  role: OracleMessageRole;
  content: OracleTextBlock[];
  toolCallId?: string;
  toolCalls?: OracleCohereV2ToolCall[];
};

type OracleCohereV2ChatRequestShape = {
  apiFormat: "COHEREV2";
  messages: OracleCohereV2Message[];
  tools?: OracleCohereV2ToolDefinition[];
  isStream: false;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
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
  apiFormat?: string;
  usage?: OracleUsageShape;
  choices?: OracleChatChoice[];
};

type OracleCohereChatResponseShape = {
  apiFormat?: string;
  text?: string;
  toolCalls?: Array<{
    name?: string;
    parameters?: Record<string, unknown>;
  }>;
  finishReason?: string;
  usage?: OracleUsageShape;
  errorMessage?: string;
};

type OracleCohereV2ChatResponseShape = {
  apiFormat?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    toolCalls?: Array<{
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string | Record<string, unknown>;
      };
    }>;
    toolPlan?: string;
  };
  finishReason?: string;
  usage?: OracleUsageShape;
  errorMessage?: string;
};

type OracleGenericChatRequestShape = {
  apiFormat: "GENERIC";
  isStream: false;
  messages: OracleMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxCompletionTokens?: number;
  tools?: OracleToolDefinition[];
};

type OracleChatRequestShape =
  | OracleGenericChatRequestShape
  | OracleCohereChatRequestShape
  | OracleCohereV2ChatRequestShape;

type OracleAnyChatResponseShape =
  | OracleChatResponseShape
  | OracleCohereChatResponseShape
  | OracleCohereV2ChatResponseShape;

type OracleChatResultShape = {
  modelId?: string;
  chatResponse?: OracleAnyChatResponseShape;
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

function trimOracleString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function appendOracleDescription(
  base: string | undefined,
  extra: string | undefined,
): string | undefined {
  const trimmedBase = trimOracleString(base);
  const trimmedExtra = trimOracleString(extra);
  if (!trimmedBase) {
    return trimmedExtra;
  }
  if (!trimmedExtra) {
    return trimmedBase;
  }
  return `${trimmedBase} ${trimmedExtra}`;
}

function stringifyOracleEnumValues(values: unknown[]): string | undefined {
  const entries = values
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value));
  return entries.length > 0 ? entries.join(", ") : undefined;
}

function describeOracleSchemaForCohere(schema: Record<string, unknown>): string | undefined {
  let description = appendOracleDescription(
    trimOracleString(schema.description),
    trimOracleString(schema.title),
  );

  if (Array.isArray(schema.enum)) {
    description = appendOracleDescription(
      description,
      (() => {
        const values = stringifyOracleEnumValues(schema.enum);
        return values ? `Allowed values: ${values}.` : undefined;
      })(),
    );
  }

  if (schema.type === "array") {
    const items =
      schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
        ? (schema.items as Record<string, unknown>)
        : undefined;
    const itemType = items ? normalizeOracleCohereParameterType(items.type) : undefined;
    description = appendOracleDescription(
      description,
      itemType ? `Array items should be ${itemType}.` : "Provide a JSON array.",
    );
  }

  if (schema.type === "object") {
    const propertyNames =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? Object.keys(schema.properties as Record<string, unknown>)
        : [];
    description = appendOracleDescription(
      description,
      propertyNames.length > 0
        ? `Provide a JSON object with keys such as ${propertyNames.join(", ")}.`
        : "Provide a JSON object.",
    );
  }

  return description;
}

function normalizeOracleCohereParameterType(typeValue: unknown): string {
  if (Array.isArray(typeValue)) {
    const firstNonNull = typeValue.find((entry) => entry !== "null");
    return normalizeOracleCohereParameterType(firstNonNull);
  }
  switch (typeValue) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return "list";
    case "object":
      return "dict";
    default:
      return "Any";
  }
}

function normalizeOracleCohereParameterDefinitions(
  parameters: unknown,
): Record<string, OracleCohereToolParameterDefinition> | undefined {
  const normalized = normalizeOracleToolParameters(parameters);
  const properties =
    normalized.properties &&
    typeof normalized.properties === "object" &&
    !Array.isArray(normalized.properties)
      ? (normalized.properties as Record<string, unknown>)
      : undefined;
  if (!properties || Object.keys(properties).length === 0) {
    return undefined;
  }

  const required = new Set(
    Array.isArray(normalized.required)
      ? normalized.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );

  const definitions = Object.fromEntries(
    Object.entries(properties).map(([name, schemaValue]) => {
      const schema =
        schemaValue && typeof schemaValue === "object" && !Array.isArray(schemaValue)
          ? (schemaValue as Record<string, unknown>)
          : {};
      return [
        name,
        {
          type: normalizeOracleCohereParameterType(schema.type),
          ...(describeOracleSchemaForCohere(schema)
            ? { description: describeOracleSchemaForCohere(schema) }
            : {}),
          ...(required.has(name) ? { isRequired: true } : {}),
        } satisfies OracleCohereToolParameterDefinition,
      ];
    }),
  );

  return Object.keys(definitions).length > 0 ? definitions : undefined;
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

function convertGenericTools(tools: Tool[] | undefined): OracleToolDefinition[] | undefined {
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

function convertCohereTools(tools: Tool[] | undefined): OracleCohereToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted = tools
    .filter((tool) => typeof tool.name === "string" && tool.name.trim().length > 0)
    .map((tool) => ({
      name: tool.name,
      description: trimOracleString(tool.description) ?? `${tool.name} tool`,
      parameterDefinitions: normalizeOracleCohereParameterDefinitions(tool.parameters),
    }));

  return converted.length > 0 ? converted : undefined;
}

function convertCohereV2Tools(
  tools: Tool[] | undefined,
): OracleCohereV2ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted = tools
    .filter((tool) => typeof tool.name === "string" && tool.name.trim().length > 0)
    .map((tool) => ({
      type: "FUNCTION" as const,
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: normalizeOracleToolParameters(tool.parameters),
      },
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

function parseOracleToolArgumentsValue(
  value: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return parseToolArguments(typeof value === "string" ? value : undefined);
}

function buildOracleSharedChatOptions(params: {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  outputTokenField?: OracleOutputTokenField;
}): {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxCompletionTokens?: number;
} {
  return {
    ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
    ...(typeof params.topP === "number" ? { topP: params.topP } : {}),
    ...(typeof params.maxTokens === "number"
      ? params.outputTokenField === "maxCompletionTokens"
        ? { maxCompletionTokens: params.maxTokens }
        : { maxTokens: params.maxTokens }
      : {}),
  };
}

function buildOracleCohereToolOutputs(
  content: OracleTextBlock[] | undefined,
): Array<Record<string, unknown>> {
  const text = extractOracleText(content);
  return text ? [{ text }] : [{}];
}

function toOracleCohereV2Message(message: OracleMessage): OracleCohereV2Message | undefined {
  switch (message.role) {
    case "SYSTEM":
    case "USER":
      return message.content ? { role: message.role, content: message.content } : undefined;
    case "ASSISTANT":
      if (!message.content && !message.toolCalls) {
        return undefined;
      }
      return {
        role: "ASSISTANT",
        content: message.content ?? [],
        ...(message.toolCalls
          ? {
              toolCalls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "FUNCTION",
                function: {
                  ...(toolCall.name ? { name: toolCall.name } : {}),
                  arguments: toolCall.arguments ?? "{}",
                },
              })),
            }
          : {}),
      };
    case "TOOL":
      if (!message.toolCallId && !message.content) {
        return undefined;
      }
      return {
        role: "TOOL",
        toolCallId: trimOracleString(message.toolCallId) ?? `oracle_call_${randomUUID()}`,
        content: message.content ?? [],
      };
  }
}

function buildOracleGenericChatRequest(params: {
  modelId?: string;
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  outputTokenField: OracleOutputTokenField;
}): OracleGenericChatRequestShape {
  const convertedTools = convertGenericTools(params.tools);
  return {
    apiFormat: "GENERIC",
    isStream: false,
    messages: convertPiMessagesToOracleMessages({
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      modelId: params.modelId,
    }),
    ...buildOracleSharedChatOptions(params),
    ...(convertedTools ? { tools: convertedTools } : {}),
  };
}

function buildOracleCohereChatRequest(params: {
  modelId?: string;
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}): OracleCohereChatRequestShape {
  const oracleMessages = convertPiMessagesToOracleMessages({
    messages: params.messages,
    modelId: params.modelId,
  });
  const chatHistory: OracleCohereChatHistoryMessage[] = [];
  const assistantToolCallsById = new Map<string, OracleCohereToolCall>();
  let pendingToolResults: OracleCohereToolResult[] = [];
  let lastUserHistoryIndex = -1;

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }
    chatHistory.push({ role: "TOOL", toolResults: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of oracleMessages) {
    if (message.role !== "TOOL") {
      flushPendingToolResults();
    }

    if (message.role === "SYSTEM") {
      const text = extractOracleText(message.content);
      if (text) {
        chatHistory.push({ role: "SYSTEM", message: text });
      }
      continue;
    }

    if (message.role === "USER") {
      const text = extractOracleText(message.content);
      if (text) {
        chatHistory.push({ role: "USER", message: text });
        lastUserHistoryIndex = chatHistory.length - 1;
      }
      continue;
    }

    if (message.role === "ASSISTANT") {
      const text = extractOracleText(message.content);
      const toolCalls =
        message.toolCalls?.map((toolCall) => {
          const call = {
            name: trimOracleString(toolCall.name) ?? "tool",
            parameters: parseToolArguments(toolCall.arguments),
          } satisfies OracleCohereToolCall;
          assistantToolCallsById.set(toolCall.id, call);
          return call;
        }) ?? [];
      if (text || toolCalls.length > 0) {
        chatHistory.push({
          role: "CHATBOT",
          ...(text ? { message: text } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
      continue;
    }

    const toolCallId = trimOracleString(message.toolCallId);
    if (!toolCallId) {
      continue;
    }
    const call = assistantToolCallsById.get(toolCallId);
    if (!call) {
      continue;
    }
    pendingToolResults.push({
      call,
      outputs: buildOracleCohereToolOutputs(message.content),
    });
  }

  const toolResults = pendingToolResults.length > 0 ? pendingToolResults : undefined;
  let currentMessage = "";
  if (lastUserHistoryIndex >= 0) {
    const lastUserEntry = chatHistory[lastUserHistoryIndex];
    if (lastUserEntry?.role === "USER") {
      currentMessage = lastUserEntry.message;
      chatHistory.splice(lastUserHistoryIndex, 1);
    }
  }

  const convertedTools = convertCohereTools(params.tools);
  return {
    apiFormat: "COHERE",
    message: currentMessage,
    ...(chatHistory.length > 0 ? { chatHistory } : {}),
    ...(convertedTools ? { tools: convertedTools } : {}),
    ...(toolResults ? { toolResults } : {}),
    ...(trimOracleString(params.systemPrompt)
      ? { preambleOverride: params.systemPrompt?.trim() }
      : {}),
    isStream: false,
    ...buildOracleSharedChatOptions(params),
  };
}

function buildOracleCohereV2ChatRequest(params: {
  modelId?: string;
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}): OracleCohereV2ChatRequestShape {
  const messages = convertPiMessagesToOracleMessages({
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    modelId: params.modelId,
  })
    .map((message) => toOracleCohereV2Message(message))
    .filter((message): message is OracleCohereV2Message => Boolean(message));
  const convertedTools = convertCohereV2Tools(params.tools);
  return {
    apiFormat: "COHEREV2",
    messages,
    ...(convertedTools ? { tools: convertedTools } : {}),
    isStream: false,
    ...buildOracleSharedChatOptions(params),
  };
}

function buildOracleChatRequest(params: {
  modelId?: string;
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}): OracleChatRequestShape {
  const routing = resolveOracleModelRouting(params.modelId);
  switch (routing.apiFormat) {
    case "COHERE":
      return buildOracleCohereChatRequest(params);
    case "COHEREV2":
      return buildOracleCohereV2ChatRequest(params);
    default:
      return buildOracleGenericChatRequest({
        ...params,
        outputTokenField: routing.outputTokenField,
      });
  }
}

function normalizeOracleFinishReason(value: unknown): string | undefined {
  const trimmed = trimOracleString(value);
  return trimmed ? trimmed.toLowerCase().replaceAll("-", "_") : undefined;
}

function isOracleLengthFinishReason(reason: string | undefined): boolean {
  return reason === "length" || reason === "max_tokens";
}

function isOracleToolUseFinishReason(reason: string | undefined): boolean {
  return reason === "tool_call" || reason === "tool_use";
}

function normalizeOracleResponseApiFormat(value: unknown): OracleChatApiFormat | undefined {
  switch (trimOracleString(value)?.toUpperCase()) {
    case "COHERE":
      return "COHERE";
    case "COHEREV2":
      return "COHEREV2";
    case "GENERIC":
      return "GENERIC";
    default:
      return undefined;
  }
}

function convertGenericOracleChatResultToAssistantMessage(
  response: OracleChatResponseShape,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  const choice = response.choices?.[0];
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

  const finishReason = normalizeOracleFinishReason(choice?.finishReason);
  const stopReason: StopReason =
    toolCalls.length > 0 ? "toolUse" : isOracleLengthFinishReason(finishReason) ? "length" : "stop";

  return buildAssistantMessage({
    model,
    content,
    stopReason,
    usage: buildUsage(choice?.usage ?? response.usage),
  });
}

function convertCohereOracleChatResultToAssistantMessage(
  response: OracleCohereChatResponseShape,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: Array<{ type: "text"; text: string } | ToolCall> = [];
  const assistantText = trimOracleString(response.text);
  if (assistantText) {
    content.push({ type: "text", text: assistantText });
  }

  for (const toolCall of response.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: `oracle_call_${randomUUID()}`,
      name: trimOracleString(toolCall.name) ?? "tool",
      arguments:
        toolCall.parameters && typeof toolCall.parameters === "object" ? toolCall.parameters : {},
    });
  }

  const finishReason = normalizeOracleFinishReason(response.finishReason);
  const stopReason: StopReason =
    (response.toolCalls?.length ?? 0) > 0 || isOracleToolUseFinishReason(finishReason)
      ? "toolUse"
      : isOracleLengthFinishReason(finishReason)
        ? "length"
        : "stop";

  return buildAssistantMessage({
    model,
    content,
    stopReason,
    usage: buildUsage(response.usage),
  });
}

function convertCohereV2OracleChatResultToAssistantMessage(
  response: OracleCohereV2ChatResponseShape,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: Array<{ type: "text"; text: string } | ToolCall> = [];
  const assistantText = extractOracleText(response.message?.content);
  if (assistantText) {
    content.push({ type: "text", text: assistantText });
  }

  for (const toolCall of response.message?.toolCalls ?? []) {
    const functionShape =
      toolCall.function && typeof toolCall.function === "object"
        ? (toolCall.function as { name?: unknown; arguments?: string | Record<string, unknown> })
        : undefined;
    content.push({
      type: "toolCall",
      id:
        typeof toolCall.id === "string" && toolCall.id.trim().length > 0
          ? toolCall.id
          : `oracle_call_${randomUUID()}`,
      name: trimOracleString(functionShape?.name) ?? "tool",
      arguments: parseOracleToolArgumentsValue(functionShape?.arguments),
    });
  }

  const finishReason = normalizeOracleFinishReason(response.finishReason);
  const stopReason: StopReason =
    (response.message?.toolCalls?.length ?? 0) > 0 || isOracleToolUseFinishReason(finishReason)
      ? "toolUse"
      : isOracleLengthFinishReason(finishReason)
        ? "length"
        : "stop";

  return buildAssistantMessage({
    model,
    content,
    stopReason,
    usage: buildUsage(response.usage),
  });
}

export function convertOracleChatResultToAssistantMessage(
  chatResult: OracleChatResultShape,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  const response = chatResult.chatResponse;
  const apiFormat =
    normalizeOracleResponseApiFormat(
      (response as { apiFormat?: unknown } | undefined)?.apiFormat,
    ) ?? resolveOracleModelRouting(chatResult.modelId ?? model.id).apiFormat;
  if (apiFormat === "COHERE") {
    return convertCohereOracleChatResultToAssistantMessage(
      (response ?? {}) as OracleCohereChatResponseShape,
      model,
    );
  }
  if (apiFormat === "COHEREV2") {
    return convertCohereV2OracleChatResultToAssistantMessage(
      (response ?? {}) as OracleCohereV2ChatResponseShape,
      model,
    );
  }
  return convertGenericOracleChatResultToAssistantMessage(
    (response ?? {}) as OracleChatResponseShape,
    model,
  );
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
        const providerOptions = (options ?? {}) as Record<string, unknown>;
        const chatRequest = buildOracleChatRequest({
          modelId: model.id,
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: context.tools,
          temperature: options?.temperature,
          topP: typeof providerOptions.topP === "number" ? providerOptions.topP : undefined,
          maxTokens: options?.maxTokens,
        });
        const response = (await client.chat({
          chatDetails: {
            compartmentId: auth.compartmentId,
            servingMode: {
              servingType: "ON_DEMAND",
              modelId: model.id,
            },
            chatRequest,
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
