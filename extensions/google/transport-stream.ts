// Google plugin module implements transport stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  calculateCost,
  getEnvApiKey,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "openclaw/plugin-sdk/llm";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderHttpError,
  providerOperationRetryConfig,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildGuardedModelFetch,
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
  sortPromptCacheToolsByName,
  stripSystemPromptCacheBoundary,
  transformTransportMessages,
  type WritableTransportStream,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseGeminiAuth } from "./gemini-auth.js";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { normalizeGoogleApiBaseUrl } from "./provider-policy.js";
import {
  isGoogleGemini25ThinkingBudgetModel,
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  resolveGoogleGemini3ThinkingLevel,
  stripInvalidGoogleThinkingBudget,
  type GoogleThinkingInputLevel,
  type GoogleThinkingLevel,
} from "./thinking-api.js";
import {
  isGoogleVertexCredentialsMarker,
  resolveGoogleVertexAuthorizedUserHeaders,
} from "./vertex-adc.js";

type CanonicalGoogleTransportApi = "google-generative-ai" | "google-vertex";
type GoogleTransportApi = CanonicalGoogleTransportApi | "openclaw-google-generative-ai-transport";

type GoogleTransportModel = Model<GoogleTransportApi> & {
  headers?: Record<string, string>;
  provider: string;
};

type GoogleTransportOptions = SimpleStreamOptions & {
  cachedContent?: string;
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
};

type GoogleGenerateContentRequest = {
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};

const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS = 45_000;
const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV = "OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS";

type GoogleTransportContentBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<GoogleTransportContentBlock>;
  api: CanonicalGoogleTransportApi;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
};

const GOOGLE_VERTEX_DEFAULT_API_VERSION = "v1";

type GoogleSseChunk = {
  responseId?: string;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: GoogleFunctionCall;
      }>;
    };
    finishReason?: string;
    finishMessage?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    totalTokenCount?: number;
  };
};

type GooglePartialFunctionArgument = {
  jsonPath?: string;
  boolValue?: boolean;
  nullValue?: "NULL_VALUE" | null;
  numberValue?: number;
  stringValue?: string;
  willContinue?: boolean;
};

type GoogleFunctionCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  partialArgs?: GooglePartialFunctionArgument[];
  willContinue?: boolean;
};

type GooglePendingToolCall = {
  block: Extract<GoogleTransportContentBlock, { type: "toolCall" }>;
  contentIndex: number;
  fragmentsByPath: Map<string, unknown>;
  pending: boolean;
  providerId?: string;
};

type GoogleUsageMetadata = NonNullable<GoogleSseChunk["usageMetadata"]>;

let toolCallCounter = 0;
const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";
const MAX_GOOGLE_PARTIAL_ARGUMENT_ARRAY_INDEX = 1024;

function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function requiresToolCallThoughtSignature(modelId: string): boolean {
  return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const match = normalizeLowercaseStringOrEmpty(modelId).match(/(?:^|\/)gemini(?:-live)?-(\d+)/);
  if (!match) {
    return true;
  }
  return Number.parseInt(match[1] ?? "", 10) >= 3;
}

function retainThoughtSignature(existing: string | undefined, incoming: string | undefined) {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

function googlePartialArgumentPath(jsonPath: string | undefined): Array<string | number> {
  if (!jsonPath?.startsWith("$")) {
    return [];
  }
  const segments: Array<string | number> = [];
  const segmentPattern =
    /\.([A-Za-z_$\u0080-\u{10ffff}][\w$\u0080-\u{10ffff}-]*)|\[\s*(\d+)\s*\]|\[\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\]/gu;
  let offset = 1;
  for (const match of jsonPath.matchAll(segmentPattern)) {
    if (match.index !== offset) {
      return [];
    }
    const bracketName = match[3];
    let key = match[1] ?? match[2];
    if (bracketName) {
      try {
        let jsonName = '"';
        for (let index = 1; index < bracketName.length - 1; index += 1) {
          const character = bracketName[index];
          if (character === "\\") {
            const escaped = bracketName[++index];
            if (!escaped) {
              return [];
            }
            jsonName += escaped === "'" ? "'" : escaped === '"' ? '\\"' : `\\${escaped}`;
          } else {
            jsonName += character === '"' ? '\\"' : character;
          }
        }
        const decodedName: unknown = JSON.parse(`${jsonName}"`);
        if (typeof decodedName !== "string") {
          return [];
        }
        key = decodedName;
      } catch {
        return [];
      }
    }
    if (key === undefined || key === "__proto__" || key === "constructor" || key === "prototype") {
      return [];
    }
    if (match[2]) {
      const index = Number(key);
      // A model-controlled sparse index can expand into millions of JSON nulls
      // when completed arguments are emitted to the agent/tool consumer.
      if (!Number.isSafeInteger(index) || index > MAX_GOOGLE_PARTIAL_ARGUMENT_ARRAY_INDEX) {
        throw invalidGoogleFunctionCall("an unsafe array index");
      }
      segments.push(index);
    } else {
      segments.push(key);
    }
    offset += match[0].length;
  }
  return offset === jsonPath.length ? segments : [];
}

function invalidGoogleFunctionCall(reason: string): Error {
  return Object.assign(new Error(`Google function call contains ${reason}`), {
    code: "INVALID_FUNCTION_CALL",
    type: "google_invalid_tool_call",
  });
}

function assignGooglePartialArgument(
  argumentsObject: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
): void {
  if (path.length === 0) {
    return;
  }
  let current: Record<string, unknown> | unknown[] = argumentsObject;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (key === undefined) {
      return;
    }
    const existing = current[key as keyof typeof current];
    if (!isRecord(existing) && !Array.isArray(existing)) {
      current[key as keyof typeof current] = (
        typeof path[index + 1] === "number" ? [] : {}
      ) as never;
    }
    current = current[key as keyof typeof current] as Record<string, unknown> | unknown[];
  }
  const finalKey = path[path.length - 1];
  if (finalKey !== undefined) {
    current[finalKey as keyof typeof current] = value as never;
  }
}

function mergeGoogleFunctionCallArguments(
  pendingCall: GooglePendingToolCall,
  functionCall: GoogleFunctionCall,
): void {
  if (functionCall.args) {
    // Object spread defines own properties, including a literal __proto__ key;
    // Object.assign would invoke its legacy setter on model-controlled JSON.
    pendingCall.block.arguments = { ...pendingCall.block.arguments, ...functionCall.args };
  }
  for (const partialArg of functionCall.partialArgs ?? []) {
    const path = googlePartialArgumentPath(partialArg.jsonPath);
    if (path.length === 0 || !partialArg.jsonPath) {
      throw invalidGoogleFunctionCall("an invalid or unsafe partial argument path");
    }
    let value: unknown;
    if (typeof partialArg.stringValue === "string") {
      const previous = pendingCall.fragmentsByPath.get(partialArg.jsonPath);
      value =
        typeof previous === "string"
          ? `${previous}${partialArg.stringValue}`
          : partialArg.stringValue;
    } else if (typeof partialArg.boolValue === "boolean") {
      value = partialArg.boolValue;
    } else if (typeof partialArg.numberValue === "number") {
      value = partialArg.numberValue;
    } else if (partialArg.nullValue === null || partialArg.nullValue === "NULL_VALUE") {
      value = null;
    } else {
      continue;
    }
    pendingCall.fragmentsByPath.set(partialArg.jsonPath, value);
    assignGooglePartialArgument(pendingCall.block.arguments, path, value);
  }
}

function stableStringifyGoogleToolCallValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyGoogleToolCallValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyGoogleToolCallValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isJsonLikeThoughtSignature(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.includes('":') ||
    trimmed.includes('","') ||
    trimmed.includes('"type"')
  );
}

const GEMINI_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GEMINI_THOUGHT_SIGNATURE_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function hasGeminiThoughtSignatureTruncationFootprint(value: string): boolean {
  return GEMINI_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value);
}

function isGeminiThoughtSignaturePayload(value: string): boolean {
  return GEMINI_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length > 0;
}

function sanitizeGeminiThoughtSignature(thoughtSignature: string | undefined): string | undefined {
  if (typeof thoughtSignature !== "string") {
    return undefined;
  }
  const trimmed = thoughtSignature.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isJsonLikeThoughtSignature(trimmed)) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (
    lowered === "reasoning" ||
    lowered === normalizeLowercaseStringOrEmpty(GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP)
  ) {
    return undefined;
  }
  if (hasGeminiThoughtSignatureTruncationFootprint(trimmed)) {
    return undefined;
  }
  if (!isGeminiThoughtSignaturePayload(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isSameGoogleTransportRoute(
  source: { api?: string; provider?: string; model?: string },
  model: GoogleTransportModel,
): boolean {
  return (
    source.provider === model.provider &&
    normalizeGoogleTransportRouteApi(source.api) === normalizeGoogleTransportRouteApi(model.api) &&
    source.model === model.id
  );
}

function normalizeGoogleTransportRouteApi(
  api: string | undefined,
): CanonicalGoogleTransportApi | undefined {
  switch (api) {
    case "google-generative-ai":
    case "openclaw-google-generative-ai-transport":
      return "google-generative-ai";
    case "google-vertex":
      return "google-vertex";
    default:
      return undefined;
  }
}

function normalizeGoogleTransportModelRoute(model: GoogleTransportModel): GoogleTransportModel {
  const api = normalizeGoogleTransportRouteApi(model.api);
  return api && api !== model.api ? Object.assign({}, model, { api }) : model;
}

function normalizeGoogleTransportMessageRoutes(messages: Context["messages"]): Context["messages"] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }
    const api = normalizeGoogleTransportRouteApi(msg.api);
    return api && api !== msg.api ? Object.assign({}, msg, { api }) : msg;
  });
}

function toolCallThoughtSignatureReplayKey(block: {
  id: string;
  name: string;
  arguments: unknown;
}): string {
  return [
    block.id,
    block.name,
    stableStringifyGoogleToolCallValue(coerceTransportToolCallArguments(block.arguments)),
  ].join("\u0000");
}

function mapToolChoice(
  choice: GoogleTransportOptions["toolChoice"],
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { mode: "ANY", allowedFunctionNames: [choice.function.name] };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

function mapStopReasonString(reason: string): "stop" | "length" | "error" {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      return "error";
  }
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function resolveGoogleModelPath(modelId: string): string {
  if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) {
    return modelId;
  }
  return `models/${stripGoogleProviderPrefix(modelId)}`;
}

function buildGoogleGenerativeAiRequestUrl(model: GoogleTransportModel): string {
  const baseUrl = normalizeGoogleApiBaseUrl(model.baseUrl);
  return `${baseUrl}/${resolveGoogleModelPath(model.id)}:streamGenerateContent?alt=sse`;
}

function resolveGoogleVertexProject(options: GoogleTransportOptions | undefined): string {
  const project =
    normalizeOptionalString((options as { project?: unknown } | undefined)?.project) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(process.env.GCLOUD_PROJECT);
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveGoogleVertexLocation(options: GoogleTransportOptions | undefined): string {
  const location =
    normalizeOptionalString((options as { location?: unknown } | undefined)?.location) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}

function resolveGoogleVertexBaseOrigin(model: GoogleTransportModel, location: string): string {
  const configured = normalizeOptionalString(model.baseUrl);
  if (configured && !configured.includes("{location}")) {
    try {
      const url = new URL(configured);
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    } catch {
      return configured.replace(/\/+$/u, "");
    }
  }
  if (location === "global") {
    return "https://aiplatform.googleapis.com";
  }
  // Multi-region locations (eu, us) use the dedicated .rep.googleapis.com host
  // with the location embedded in the host, matching @google/genai SDK behavior.
  // A regional prefix (eu-aiplatform.googleapis.com) returns an HTML 404.
  if (location === "eu" || location === "us") {
    return `https://aiplatform.${location}.rep.googleapis.com`;
  }
  return `https://${location}-aiplatform.googleapis.com`;
}

function buildGoogleVertexRequestUrl(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): string {
  const project = encodeURIComponent(resolveGoogleVertexProject(options));
  const location = encodeURIComponent(resolveGoogleVertexLocation(options));
  // Mirror resolveGoogleModelPath: strip the google/ provider prefix so a
  // provider-qualified id does not become an invalid models/google%2F... path.
  const modelId = encodeURIComponent(stripGoogleProviderPrefix(model.id));
  const origin = resolveGoogleVertexBaseOrigin(model, decodeURIComponent(location));
  return `${origin}/${GOOGLE_VERTEX_DEFAULT_API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;
}

function resolveThinkingLevel(level: ThinkingLevel, modelId: string): GoogleThinkingLevel {
  const resolved = resolveGoogleGemini3ThinkingLevel({ modelId, thinkingLevel: level });
  if (resolved) {
    return resolved;
  }
  throw new Error("Unsupported thinking level");
}

function resolveExplicitThinkingLevel(
  level: GoogleThinkingLevel,
  modelId: string,
): GoogleThinkingLevel {
  return (
    resolveGoogleGemini3ThinkingLevel({
      modelId,
      thinkingLevel: level.toLowerCase() as GoogleThinkingInputLevel,
    }) ?? level
  );
}

function getDisabledThinkingConfig(modelId: string): Record<string, unknown> | undefined {
  const thinkingLevel = resolveGoogleGemini3ThinkingLevel({ modelId, thinkingLevel: "off" });
  if (thinkingLevel) {
    return { thinkingLevel };
  }
  return normalizeGoogleThinkingConfig(modelId, { thinkingBudget: 0 });
}

function getGoogleThinkingBudget(
  modelId: string,
  effort: ThinkingLevel,
  customBudgets?: GoogleTransportOptions["thinkingBudgets"],
): number | undefined {
  const normalizedEffort = effort === "xhigh" || effort === "max" ? "high" : effort;
  if (customBudgets?.[normalizedEffort] !== undefined) {
    return customBudgets[normalizedEffort];
  }
  if (modelId.includes("2.5-pro")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[normalizedEffort];
  }
  if (modelId.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[normalizedEffort];
  }
  if (modelId.includes("2.5-flash")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[normalizedEffort];
  }
  return undefined;
}

function isAdaptiveReasoningLevel(value: unknown): value is "adaptive" {
  return value === "adaptive";
}

function resolveGoogleThinkingConfig(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): Record<string, unknown> | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  if (options?.thinking) {
    if (!options.thinking.enabled) {
      return getDisabledThinkingConfig(model.id);
    }
    const config: Record<string, unknown> = { includeThoughts: true };
    if (options.thinking.level) {
      config.thinkingLevel = resolveExplicitThinkingLevel(options.thinking.level, model.id);
    } else if (typeof options.thinking.budgetTokens === "number") {
      const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
        modelId: model.id,
        thinkingBudget: options.thinking.budgetTokens,
      });
      if (thinkingLevel) {
        config.thinkingLevel = thinkingLevel;
      } else {
        config.thinkingBudget = options.thinking.budgetTokens;
      }
    }
    return normalizeGoogleThinkingConfig(model.id, config);
  }
  if (!options?.reasoning || options.reasoning === "off") {
    return getDisabledThinkingConfig(model.id);
  }
  if (isAdaptiveReasoningLevel(options.reasoning)) {
    if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) {
      return { includeThoughts: true };
    }
    if (isGoogleGemini25ThinkingBudgetModel(model.id)) {
      return normalizeGoogleThinkingConfig(model.id, {
        includeThoughts: true,
        thinkingBudget: -1,
      });
    }
  }
  if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) {
    return {
      includeThoughts: true,
      thinkingLevel: resolveThinkingLevel(options.reasoning, model.id),
    };
  }
  const budget = getGoogleThinkingBudget(model.id, options.reasoning, options.thinkingBudgets);
  return normalizeGoogleThinkingConfig(model.id, {
    includeThoughts: true,
    ...(typeof budget === "number" ? { thinkingBudget: budget } : {}),
  });
}

function normalizeGoogleThinkingConfig(
  modelId: string,
  thinkingConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  stripInvalidGoogleThinkingBudget({ thinkingConfig, modelId });
  return Object.keys(thinkingConfig).length > 0 ? thinkingConfig : undefined;
}

function convertGoogleMessages(model: GoogleTransportModel, context: Context) {
  const contents: Array<Record<string, unknown>> = [];
  const replayToolCallThoughtSignatures = new Map<string, string>();
  const forwardedToolCallIds = new Set<string>();
  const shouldReplayToolCallThoughtSignature = requiresToolCallThoughtSignature(model.id);
  const routeModel = normalizeGoogleTransportModelRoute(model);
  const transformedMessages = transformTransportMessages(
    normalizeGoogleTransportMessageRoutes(context.messages),
    routeModel,
    (id) => (requiresToolCallId(model.id) ? normalizeToolCallId(id) : id),
    {
      preserveCrossModelToolCallThoughtSignature: requiresToolCallThoughtSignature(model.id),
    },
  );
  // Parallel calls need one immediate function-response turn. Gemini < 3 images cannot
  // live inside functionResponse, so hold them until the consecutive result run ends.
  const pendingToolResultImageTurns: Array<Record<string, unknown>> = [];
  let activeToolResultParts: Array<Record<string, unknown>> | undefined;
  const flushToolResultRun = (): void => {
    contents.push(...pendingToolResultImageTurns);
    pendingToolResultImageTurns.length = 0;
    activeToolResultParts = undefined;
  };

  for (const msg of transformedMessages) {
    if (msg.role !== "toolResult") {
      flushToolResultRun();
    }
    if (msg.role === "user") {
      forwardedToolCallIds.clear();
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeTransportPayloadText(msg.content) || " " }],
        });
        continue;
      }
      const parts = msg.content
        .map((item) =>
          item.type === "text"
            ? { text: sanitizeTransportPayloadText(item.text) || " " }
            : {
                inlineData: {
                  mimeType: item.mimeType,
                  data: item.data,
                },
              },
        )
        .filter((item) => model.input.includes("image") || !("inlineData" in item));
      if (parts.length === 0) {
        parts.push({ text: " " });
      }
      contents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      forwardedToolCallIds.clear();
      const isSameRoute = isSameGoogleTransportRoute(msg, model);
      const parts: Array<Record<string, unknown>> = [];
      const nextReplayToolCallThoughtSignatures = new Map<string, string>();
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) {
            continue;
          }
          const sanitizedTextSignature = isSameRoute
            ? sanitizeGeminiThoughtSignature(block.textSignature)
            : undefined;
          parts.push({
            text: sanitizeTransportPayloadText(block.text),
            ...(sanitizedTextSignature ? { thoughtSignature: sanitizedTextSignature } : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          if (!block.thinking.trim()) {
            continue;
          }
          if (isSameRoute) {
            const sanitizedThinkingSignature = sanitizeGeminiThoughtSignature(
              block.thinkingSignature,
            );
            parts.push({
              thought: true,
              text: sanitizeTransportPayloadText(block.thinking),
              ...(sanitizedThinkingSignature
                ? { thoughtSignature: sanitizedThinkingSignature }
                : {}),
            });
          } else {
            parts.push({ text: sanitizeTransportPayloadText(block.thinking) });
          }
          continue;
        }
        if (block.type === "toolCall") {
          const shouldForwardToolCallId = requiresToolCallId(model.id) || isSameRoute;
          if (shouldForwardToolCallId) {
            forwardedToolCallIds.add(block.id);
          }
          const replayKey = toolCallThoughtSignatureReplayKey(block);
          const replayedThoughtSignature =
            shouldReplayToolCallThoughtSignature && isSameRoute
              ? replayToolCallThoughtSignatures.get(replayKey)
              : undefined;
          // Use a block's own same-route signature first; otherwise fall back
          // to a same-route replayed value from already-converted context.
          // Never replay signatures from foreign providers — Gemini requires
          // its own signatures returned exactly as issued.
          const ownSignature = isSameRoute
            ? sanitizeGeminiThoughtSignature(block.thoughtSignature)
            : undefined;
          if (ownSignature) {
            nextReplayToolCallThoughtSignatures.set(replayKey, ownSignature);
          }
          const thoughtSignature =
            ownSignature ??
            replayedThoughtSignature ??
            (shouldReplayToolCallThoughtSignature
              ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
              : undefined);
          parts.push({
            functionCall: {
              name: block.name,
              args: coerceTransportToolCallArguments(block.arguments),
              ...(shouldForwardToolCallId ? { id: block.id } : {}),
            },
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
        }
      }
      for (const [key, signature] of nextReplayToolCallThoughtSignatures) {
        replayToolCallThoughtSignatures.set(key, signature);
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const imageContent = model.input.includes("image")
        ? msg.content.filter(
            (item): item is Extract<(typeof msg.content)[number], { type: "image" }> =>
              item.type === "image" && describeToolResultMediaPlaceholder([item]) !== undefined,
          )
        : [];
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const responseValue = textResult
        ? sanitizeTransportPayloadText(textResult)
        : (mediaPlaceholder ?? "");
      const imageParts = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data,
        },
      }));
      const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);
      const functionResponse = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(modelSupportsMultimodalFunctionResponse && imageParts.length > 0
            ? { parts: imageParts }
            : {}),
          ...(requiresToolCallId(model.id) || forwardedToolCallIds.has(msg.toolCallId)
            ? { id: msg.toolCallId }
            : {}),
        },
      };
      if (activeToolResultParts) {
        activeToolResultParts.push(functionResponse);
      } else {
        activeToolResultParts = [functionResponse];
        contents.push({ role: "user", parts: activeToolResultParts });
      }
      if (imageParts.length > 0 && !modelSupportsMultimodalFunctionResponse) {
        pendingToolResultImageTurns.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts],
        });
      }
    }
  }
  flushToolResultRun();
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }
  return contents;
}

function convertGoogleTools(tools: NonNullable<Context["tools"]>) {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: sortPromptCacheToolsByName(tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

export function buildGoogleGenerativeAiParams(
  model: GoogleTransportModel,
  context: Context,
  options?: GoogleTransportOptions,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {};
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number") {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop;
  }
  const thinkingConfig = resolveGoogleThinkingConfig(model, options);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const params: GoogleGenerateContentRequest = {
    contents: convertGoogleMessages(model, context),
  };
  const cachedContent =
    typeof options?.cachedContent === "string" ? options.cachedContent.trim() : "";
  if (cachedContent) {
    params.cachedContent = cachedContent;
  }
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (!cachedContent && context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ],
    };
  }
  if (!cachedContent && context.tools?.length) {
    params.tools = convertGoogleTools(context.tools);
    const toolChoice = mapToolChoice(options?.toolChoice);
    if (toolChoice) {
      params.toolConfig = {
        functionCallingConfig: toolChoice,
      };
    }
  }
  return params;
}

function buildGoogleHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const authHeaders = apiKey ? parseGeminiAuth(apiKey).headers : undefined;
  return (
    resolveProviderRequestHeaders({
      provider: model.provider,
      api: normalizeGoogleTransportRouteApi(model.api),
      baseUrl: model.baseUrl,
      capability: "llm",
      transport: "stream",
      defaultHeaders: mergeTransportHeaders(
        {
          "Content-Type": "application/json",
          accept: "text/event-stream",
        },
        authHeaders,
        model.headers,
      ),
      callerHeaders: optionHeaders,
      precedence: "caller-wins",
    }) ?? {
      "Content-Type": "application/json",
      accept: "text/event-stream",
    }
  );
}

function isGoogleOauthApiKey(apiKey: string | undefined): boolean {
  return Boolean(
    apiKey?.trimStart().startsWith("{") && parseGeminiAuth(apiKey).headers.Authorization,
  );
}

function hasGoogleAuthHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized === "authorization" || normalized === "x-goog-api-key";
  });
}

function collectGoogleTransportApiKeys(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
  primaryApiKey: string | undefined;
}): string[] {
  if (
    params.kind !== "google-generative-ai" ||
    !isOfficialGoogleGenerativeAiBaseUrl(params.model.baseUrl) ||
    isGoogleOauthApiKey(params.primaryApiKey) ||
    hasGoogleAuthHeader(params.model.headers) ||
    hasGoogleAuthHeader(params.options?.headers)
  ) {
    return [];
  }
  return collectProviderApiKeysForExecution({
    provider: params.model.provider,
    primaryApiKey: params.primaryApiKey,
  });
}

async function buildGoogleVertexHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
  fetchImpl?: typeof fetch,
): Promise<Record<string, string>> {
  const authHeaders = isGoogleVertexCredentialsMarker(apiKey)
    ? await resolveGoogleVertexAuthorizedUserHeaders(fetchImpl)
    : { "x-goog-api-key": apiKey };
  return (
    mergeTransportHeaders(
      {
        "Content-Type": "application/json",
        accept: "text/event-stream",
      },
      authHeaders,
      model.headers,
      optionHeaders,
    ) ?? {
      "Content-Type": "application/json",
      accept: "text/event-stream",
    }
  );
}

function buildGoogleTransportRequestUrl(
  kind: CanonicalGoogleTransportApi,
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): string {
  return kind === "google-vertex"
    ? buildGoogleVertexRequestUrl(model, options)
    : buildGoogleGenerativeAiRequestUrl(model);
}

function isOfficialGoogleGenerativeAiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return true;
  }
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}

function resolveGoogleGemini3FirstResponseRetryMs(env = process.env): number {
  const raw = env[GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV];
  if (raw === undefined || raw.trim() === "") {
    return GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
  }
  return parseStrictNonNegativeInteger(raw) ?? GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
}

function shouldRetryGoogleGemini3FirstResponse(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
}): boolean {
  if (params.kind !== "google-generative-ai") {
    return false;
  }
  if (!isOfficialGoogleGenerativeAiBaseUrl(params.model.baseUrl)) {
    return false;
  }
  return isGoogleGemini3ProModel(params.model.id) || isGoogleGemini3FlashModel(params.model.id);
}

function resolveGoogleGemini3RetryThinkingLevel(modelId: string): GoogleThinkingLevel | undefined {
  if (isGoogleGemini3ProModel(modelId)) {
    return "LOW";
  }
  if (isGoogleGemini3FlashModel(modelId)) {
    return "MINIMAL";
  }
  return undefined;
}

function cloneGoogleGenerateContentRequest(
  params: GoogleGenerateContentRequest,
): GoogleGenerateContentRequest {
  const serialized = JSON.stringify(params);
  return JSON.parse(serialized) as GoogleGenerateContentRequest;
}

function buildGoogleGemini3FirstResponseRetryParams(params: {
  model: GoogleTransportModel;
  request: GoogleGenerateContentRequest;
}): GoogleGenerateContentRequest | undefined {
  const thinkingLevel = resolveGoogleGemini3RetryThinkingLevel(params.model.id);
  if (!thinkingLevel) {
    return undefined;
  }
  const retryRequest = cloneGoogleGenerateContentRequest(params.request);
  const generationConfig =
    retryRequest.generationConfig && typeof retryRequest.generationConfig === "object"
      ? retryRequest.generationConfig
      : {};
  const thinkingConfig =
    generationConfig.thinkingConfig && typeof generationConfig.thinkingConfig === "object"
      ? { ...(generationConfig.thinkingConfig as Record<string, unknown>) }
      : {};

  // Gemini 3 defaults to dynamic high thinking when the request omits an
  // explicit level. On a zero-output stall, retry with the smallest supported
  // native level and suppress thought streaming so the recovery call prioritizes
  // producing a visible first token.
  delete thinkingConfig.thinkingBudget;
  delete thinkingConfig.includeThoughts;
  thinkingConfig.thinkingLevel = thinkingLevel;
  generationConfig.thinkingConfig = thinkingConfig;
  retryRequest.generationConfig = generationConfig;
  return retryRequest;
}

function createChildSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => {
    controller.abort(parent?.reason);
  };
  if (parent) {
    if (parent.aborted) {
      abortFromParent();
    } else {
      parent.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Google Gemini first response retry deadline reached"));
    }, timeoutMs);
    timeout.unref?.();
  }
  const clearDeadline = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clearDeadline,
    cleanup: () => {
      clearDeadline();
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function iteratorToAsyncGenerator<T>(
  iterator: AsyncIterator<T>,
  cleanup?: () => void,
): AsyncGenerator<T> {
  return (async function* () {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      cleanup?.();
      await iterator.return?.();
    }
  })();
}

type GoogleSseAttempt =
  | {
      type: "ready";
      firstChunk?: GoogleSseChunk;
      chunks: AsyncGenerator<GoogleSseChunk>;
    }
  | { type: "timeout" };

async function openGoogleSseAttempt(params: {
  guardedFetch: ReturnType<typeof buildGuardedModelFetch>;
  url: string;
  headers: Record<string, string>;
  request: GoogleGenerateContentRequest;
  parentSignal?: AbortSignal;
  firstResponseTimeoutMs: number;
  errorPrefix: string;
}): Promise<GoogleSseAttempt> {
  const attemptSignal =
    params.firstResponseTimeoutMs > 0
      ? createChildSignal(params.parentSignal, params.firstResponseTimeoutMs)
      : undefined;
  const signal = attemptSignal?.signal ?? params.parentSignal;
  try {
    const response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.request),
      signal,
    });
    if (!response.ok) {
      throw await createProviderHttpError(response, params.errorPrefix);
    }
    const chunks = parseGoogleSseChunks(response, signal);
    const iterator = chunks[Symbol.asyncIterator]();
    const first = await iterator.next();
    attemptSignal?.clearDeadline();
    if (first.done) {
      return {
        type: "ready",
        chunks: iteratorToAsyncGenerator(iterator, attemptSignal?.cleanup),
      };
    }
    return {
      type: "ready",
      firstChunk: first.value,
      chunks: iteratorToAsyncGenerator(iterator, attemptSignal?.cleanup),
    };
  } catch (error) {
    attemptSignal?.cleanup();
    if (attemptSignal?.timedOut() && !params.parentSignal?.aborted) {
      return { type: "timeout" };
    }
    throw error;
  }
}

async function openGoogleSseChunks(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
  guardedFetch: ReturnType<typeof buildGuardedModelFetch>;
  url: string;
  headers: Record<string, string>;
  request: GoogleGenerateContentRequest;
}): Promise<Extract<GoogleSseAttempt, { type: "ready" }>> {
  const errorPrefix =
    params.kind === "google-vertex"
      ? "Google Vertex AI API error"
      : "Google Generative AI API error";
  if (!shouldRetryGoogleGemini3FirstResponse({ kind: params.kind, model: params.model })) {
    const response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.request),
      signal: params.options?.signal,
    });
    if (!response.ok) {
      throw await createProviderHttpError(response, errorPrefix);
    }
    return {
      type: "ready",
      chunks: parseGoogleSseChunks(response, params.options?.signal),
    };
  }

  const retryMs = resolveGoogleGemini3FirstResponseRetryMs();
  const retryRequest =
    retryMs > 0
      ? buildGoogleGemini3FirstResponseRetryParams({
          model: params.model,
          request: params.request,
        })
      : undefined;
  if (!retryRequest) {
    const response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.request),
      signal: params.options?.signal,
    });
    if (!response.ok) {
      throw await createProviderHttpError(response, errorPrefix);
    }
    return {
      type: "ready",
      chunks: parseGoogleSseChunks(response, params.options?.signal),
    };
  }

  const firstAttempt = await openGoogleSseAttempt({
    guardedFetch: params.guardedFetch,
    url: params.url,
    headers: params.headers,
    request: params.request,
    parentSignal: params.options?.signal,
    firstResponseTimeoutMs: retryMs,
    errorPrefix,
  });
  if (firstAttempt.type === "ready") {
    return firstAttempt;
  }

  const retryAttempt = await openGoogleSseAttempt({
    guardedFetch: params.guardedFetch,
    url: params.url,
    headers: params.headers,
    request: retryRequest,
    parentSignal: params.options?.signal,
    firstResponseTimeoutMs: 0,
    errorPrefix,
  });
  if (retryAttempt.type === "timeout") {
    throw new Error("Google Gemini first response retry timed out unexpectedly");
  }
  return retryAttempt;
}

async function buildGoogleTransportHeaders(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  apiKey: string | undefined;
  optionHeaders: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, string>> {
  return params.kind === "google-vertex"
    ? await buildGoogleVertexHeaders(
        params.model,
        params.apiKey,
        params.optionHeaders,
        params.fetchImpl,
      )
    : buildGoogleHeaders(params.model, params.apiKey, params.optionHeaders);
}

function parseGoogleSseChunk(data: string): GoogleSseChunk {
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    throw new Error("Google SSE stream returned malformed JSON");
  }
  if (!isRecord(chunk)) {
    throw new Error("Google SSE stream returned malformed JSON");
  }
  if (isRecord(chunk.error)) {
    const errorCode =
      normalizeOptionalString(chunk.error.status) ??
      (typeof chunk.error.code === "number" ? String(chunk.error.code) : undefined) ??
      "GOOGLE_STREAM_ERROR";
    const errorMessage =
      normalizeOptionalString(chunk.error.message) ?? "Provider returned a streamed error";
    throw Object.assign(new Error(`Google stream error (${errorCode}): ${errorMessage}`), {
      code: errorCode,
      type: "google_stream_failed",
    });
  }
  return chunk as GoogleSseChunk;
}

async function* parseGoogleSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode().replace(/\r/g, "");
        const trailing = buffer.trim();
        if (trailing) {
          const onlySseMetadata = trailing
            .split("\n")
            .every((line) => /^\s*(?::|(?:event|id|retry)(?::|$))/u.test(line));
          if (onlySseMetadata) {
            completed = true;
            break;
          }
          // The SDK accepts only complete SSE frames; bare provider errors still
          // carry the actionable status when a stream fails after a valid chunk.
          if (trailing.startsWith("{")) {
            parseGoogleSseChunk(trailing);
          }
          throw Object.assign(new Error("Google SSE stream ended with an incomplete event"), {
            code: "STREAM_INCOMPLETE",
            type: "google_incomplete_stream",
          });
        }
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
        }
        yield parseGoogleSseChunk(data);
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function updateUsage(
  output: MutableAssistantOutput,
  model: GoogleTransportModel,
  chunk: GoogleSseChunk,
  knownUsage: GoogleUsageMetadata,
) {
  if (!chunk.usageMetadata) {
    return;
  }
  Object.assign(knownUsage, chunk.usageMetadata);
  const promptTokens = knownUsage.promptTokenCount ?? 0;
  const cacheRead = knownUsage.cachedContentTokenCount ?? 0;
  const toolUsePromptTokens = knownUsage.toolUsePromptTokenCount ?? 0;
  const outputTokens =
    (knownUsage.candidatesTokenCount ?? 0) + (knownUsage.thoughtsTokenCount ?? 0);
  const totalTokens =
    chunk.usageMetadata.totalTokenCount ??
    (Object.keys(chunk.usageMetadata).some((field) => field !== "totalTokenCount")
      ? promptTokens + outputTokens + toolUsePromptTokens
      : (knownUsage.totalTokenCount ?? promptTokens + outputTokens + toolUsePromptTokens));
  knownUsage.totalTokenCount = totalTokens;
  output.usage = {
    input: Math.max(0, promptTokens - cacheRead) + toolUsePromptTokens,
    output: outputTokens,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, output.usage);
}

function pushTextBlockEnd(
  stream: WritableTransportStream,
  output: MutableAssistantOutput,
  blockIndex: number,
) {
  const block = output.content[blockIndex];
  if (!block) {
    return;
  }
  if (block.type === "thinking") {
    stream.push({
      type: "thinking_end",
      contentIndex: blockIndex,
      content: block.thinking,
      partial: output as never,
    });
    return;
  }
  if (block.type === "text") {
    stream.push({
      type: "text_end",
      contentIndex: blockIndex,
      content: block.text,
      partial: output as never,
    });
  }
}

function createGoogleTransportStreamFn(kind: CanonicalGoogleTransportApi): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as GoogleTransportModel;
    const options = rawOptions as GoogleTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant",
        content: [],
        api: kind,
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? undefined;
        // Google owns SSE parsing; OpenAI-oriented sanitizing drops unframed
        // provider errors before this transport can expose their real status.
        const guardedFetch = buildGuardedModelFetch(model, undefined, { sanitizeSse: false });
        let params = buildGoogleGenerativeAiParams(model, context, options);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as GoogleGenerateContentRequest;
        }
        const requestUrl = buildGoogleTransportRequestUrl(kind, model, options);
        const fetchImpl = (options as { fetch?: typeof fetch } | undefined)?.fetch;
        const openSse = async (apiKeyForRequest: string | undefined) => {
          const requestHeaders = await buildGoogleTransportHeaders({
            kind,
            model,
            apiKey: apiKeyForRequest,
            optionHeaders: options?.headers,
            fetchImpl,
          });
          return await openGoogleSseChunks({
            kind,
            model,
            options,
            guardedFetch,
            url: requestUrl,
            headers: requestHeaders,
            request: params,
          });
        };
        const apiKeys = collectGoogleTransportApiKeys({
          kind,
          model,
          options,
          primaryApiKey: apiKey,
        });
        const sse =
          apiKeys.length > 0
            ? await executeWithApiKeyRotation({
                provider: model.provider,
                apiKeys,
                transientRetry: providerOperationRetryConfig("read"),
                execute: openSse,
              })
            : await openSse(apiKey);
        stream.push({ type: "start", partial: output as never });
        let currentBlockIndex = -1;
        let sawTerminalReason = false;
        let terminalGenerationError: Error | undefined;
        const knownUsage: GoogleUsageMetadata = {};
        const toolCallsByProviderId = new Map<string, GooglePendingToolCall>();
        const pendingToolCallsByPartIndex = new Map<number, GooglePendingToolCall>();
        const pendingToolCalls = new Set<GooglePendingToolCall>();
        const chunks =
          sse.firstChunk === undefined
            ? sse.chunks
            : (async function* (firstChunk: GoogleSseChunk) {
                yield firstChunk;
                yield* sse.chunks;
              })(sse.firstChunk);
        for await (const chunk of chunks) {
          output.responseId ||= chunk.responseId;
          updateUsage(output, model, chunk, knownUsage);
          const candidate = chunk.candidates?.[0];
          const promptFeedback = chunk.promptFeedback;
          if (!candidate && promptFeedback) {
            const blockReason =
              normalizeOptionalString(promptFeedback.blockReason) ?? "PROMPT_BLOCKED";
            const blockMessage = normalizeOptionalString(promptFeedback.blockReasonMessage);
            const message = `Google prompt blocked (${blockReason})${blockMessage ? `: ${blockMessage}` : ""}`;
            throw Object.assign(new Error(message), {
              code: blockReason,
              type: "google_prompt_blocked",
            });
          }
          if (candidate?.content?.parts) {
            const providerIdsInCandidate = new Set<string>();
            for (const [partIndex, part] of candidate.content.parts.entries()) {
              const hasThoughtSignature =
                typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
              const hasText = typeof part.text === "string";
              if (hasText || (hasThoughtSignature && !part.functionCall)) {
                if (hasThoughtSignature && !hasText && part.thought !== true) {
                  const latestBlock = output.content[output.content.length - 1];
                  if (latestBlock?.type === "toolCall") {
                    latestBlock.thoughtSignature = retainThoughtSignature(
                      latestBlock.thoughtSignature,
                      part.thoughtSignature,
                    );
                    continue;
                  }
                }
                const isThinking = part.thought === true || !hasText;
                const currentBlock = output.content[currentBlockIndex];
                if (
                  currentBlockIndex < 0 ||
                  !currentBlock ||
                  (isThinking && currentBlock.type !== "thinking") ||
                  (!isThinking && currentBlock.type !== "text")
                ) {
                  if (currentBlockIndex >= 0) {
                    pushTextBlockEnd(stream, output, currentBlockIndex);
                  }
                  if (isThinking) {
                    output.content.push({ type: "thinking", thinking: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "thinking_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  } else {
                    output.content.push({ type: "text", text: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "text_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  }
                }
                const activeBlock = output.content[currentBlockIndex];
                if (activeBlock?.type === "thinking") {
                  const delta = hasText ? part.text : "";
                  activeBlock.thinking += delta;
                  activeBlock.thinkingSignature = retainThoughtSignature(
                    activeBlock.thinkingSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: currentBlockIndex,
                    delta,
                    partial: output as never,
                  });
                } else if (activeBlock?.type === "text") {
                  activeBlock.text += part.text;
                  activeBlock.textSignature = retainThoughtSignature(
                    activeBlock.textSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "text_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                  });
                }
              }
              if (part.functionCall) {
                if (currentBlockIndex >= 0) {
                  pushTextBlockEnd(stream, output, currentBlockIndex);
                  currentBlockIndex = -1;
                }
                const functionCall = part.functionCall;
                const providedId = functionCall.id;
                const repeatedProviderId =
                  typeof providedId === "string" && providerIdsInCandidate.has(providedId);
                if (typeof providedId === "string") {
                  providerIdsInCandidate.add(providedId);
                }
                const identifiedToolCall =
                  typeof providedId === "string"
                    ? toolCallsByProviderId.get(providedId)
                    : undefined;
                // Vertex can omit id and name on all fragments, including
                // final `{}` markers. Part position distinguishes parallel
                // anonymous calls that invoke the same function.
                const positionedToolCall = pendingToolCallsByPartIndex.get(partIndex);
                const positionedCallMatches =
                  positionedToolCall?.pending === true &&
                  (!functionCall.name || positionedToolCall.block.name === functionCall.name) &&
                  (!providedId ||
                    !positionedToolCall.providerId ||
                    positionedToolCall.providerId === providedId);
                const existingToolCall = positionedCallMatches
                  ? positionedToolCall
                  : repeatedProviderId
                    ? undefined
                    : identifiedToolCall;
                // Only an unfinished call with matching identity owns its continuation;
                // duplicate provider ids must never inherit another call's signature.
                const isContinuation =
                  existingToolCall?.pending === true &&
                  (!functionCall.name || existingToolCall.block.name === functionCall.name);
                let pendingToolCall: GooglePendingToolCall;
                if (isContinuation && existingToolCall) {
                  pendingToolCall = existingToolCall;
                  pendingToolCall.block.thoughtSignature = retainThoughtSignature(
                    pendingToolCall.block.thoughtSignature,
                    part.thoughtSignature,
                  );
                  if (
                    providedId &&
                    !pendingToolCall.providerId &&
                    !repeatedProviderId &&
                    !toolCallsByProviderId.has(providedId)
                  ) {
                    pendingToolCall.providerId = providedId;
                    pendingToolCall.block.id = providedId;
                    toolCallsByProviderId.set(providedId, pendingToolCall);
                  }
                } else {
                  const toolCallId =
                    providedId && !identifiedToolCall
                      ? providedId
                      : `${functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`;
                  const toolCall: Extract<GoogleTransportContentBlock, { type: "toolCall" }> = {
                    type: "toolCall",
                    id: toolCallId,
                    name: functionCall.name || "",
                    arguments: {},
                    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
                  };
                  output.content.push(toolCall);
                  pendingToolCall = {
                    block: toolCall,
                    contentIndex: output.content.length - 1,
                    fragmentsByPath: new Map<string, unknown>(),
                    pending: false,
                    ...(providedId ? { providerId: providedId } : {}),
                  };
                  if (providedId && !identifiedToolCall) {
                    toolCallsByProviderId.set(providedId, pendingToolCall);
                  }
                  stream.push({
                    type: "toolcall_start",
                    contentIndex: pendingToolCall.contentIndex,
                    partial: output as never,
                  });
                }
                mergeGoogleFunctionCallArguments(pendingToolCall, functionCall);
                pendingToolCall.pending =
                  functionCall.willContinue === true ||
                  (functionCall.willContinue !== false &&
                    (functionCall.partialArgs ?? []).some((argument) => argument.willContinue));
                if (pendingToolCall.pending) {
                  pendingToolCalls.add(pendingToolCall);
                  pendingToolCallsByPartIndex.set(partIndex, pendingToolCall);
                } else {
                  pendingToolCalls.delete(pendingToolCall);
                  if (pendingToolCallsByPartIndex.get(partIndex) === pendingToolCall) {
                    pendingToolCallsByPartIndex.delete(partIndex);
                  }
                  stream.push({
                    type: "toolcall_delta",
                    contentIndex: pendingToolCall.contentIndex,
                    delta: JSON.stringify(pendingToolCall.block.arguments),
                    partial: output as never,
                  });
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: pendingToolCall.contentIndex,
                    toolCall: pendingToolCall.block,
                    partial: output as never,
                  });
                }
              }
            }
          }
          if (
            typeof candidate?.finishReason === "string" &&
            candidate.finishReason !== "FINISH_REASON_UNSPECIFIED"
          ) {
            sawTerminalReason = true;
            output.stopReason = mapStopReasonString(candidate.finishReason);
            if (output.stopReason === "error") {
              const finishMessage = normalizeOptionalString(candidate.finishMessage);
              terminalGenerationError = Object.assign(
                new Error(
                  `Google generation stopped (${candidate.finishReason})${finishMessage ? `: ${finishMessage}` : ""}`,
                ),
                { code: candidate.finishReason, type: "google_generation_failed" },
              );
            }
            // MAX_TOKENS can leave a complete-looking partial call. Only a normal
            // Google stop may promote parsed calls into an executable tool-use turn.
            if (
              output.stopReason === "stop" &&
              output.content.some((block) => block.type === "toolCall")
            ) {
              output.stopReason = "toolUse";
            }
          }
        }
        if (currentBlockIndex >= 0) {
          pushTextBlockEnd(stream, output, currentBlockIndex);
        }
        if (terminalGenerationError && !options?.signal?.aborted) {
          throw terminalGenerationError;
        }
        if (sawTerminalReason && pendingToolCalls.size > 0 && !options?.signal?.aborted) {
          throw Object.assign(new Error("Google stream ended with an incomplete function call"), {
            code: "INCOMPLETE_FUNCTION_CALL",
            type: "google_incomplete_tool_call",
          });
        }
        if (!sawTerminalReason && !options?.signal?.aborted) {
          throw Object.assign(new Error("Google stream ended before a terminal finish reason"), {
            code: "STREAM_INCOMPLETE",
            type: "google_incomplete_stream",
          });
        }
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

export function createGoogleGenerativeAiTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-generative-ai");
}

export function createGoogleVertexTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-vertex");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
