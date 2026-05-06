import type { StreamFn } from "@mariozechner/pi-agent-core";
import { readStringValue } from "../shared/string-coerce.js";
import { mapOpenAIReasoningEffortForModel } from "./openai-reasoning-compat.js";
import { normalizeOpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import { resolveOpenAITextVerbosity } from "./openai-text-verbosity.js";
import type {
  FunctionToolDefinition,
  InputItem,
  ResponseCreateEvent,
  WarmUpEvent,
} from "./openai-ws-types.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";

type WsModel = Parameters<StreamFn>[0];
type WsContext = Parameters<StreamFn>[1];
type WsOptions = Parameters<StreamFn>[2] & {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: unknown;
  textVerbosity?: string;
  text_verbosity?: string;
  reasoning?: string;
  reasoningEffort?: string;
  reasoningSummary?: string;
};

interface PlannedWsTurnInput {
  inputItems: InputItem[];
  previousResponseId?: string;
}

type PlannedWsRequestPayload = {
  mode: "full_context" | "incremental";
  payload: ResponseCreateEvent;
  debug: PlannedWsRequestDebug;
};

export type WsInputItemDebugSummary = {
  index: number;
  type: InputItem["type"];
  role?: string;
  phase?: string;
  id?: string;
  callId?: string;
  name?: string;
  contentKind?: "text" | "parts";
  contentLength?: number;
  outputLength?: number;
  argumentsLength?: number;
  encryptedContentLength?: number;
};

export type PlannedWsRequestDebug = {
  mode: "full_context" | "incremental";
  previousResponseId?: string;
  baselineLength: number;
  fullInputLength: number;
  suffixLength: number;
  suffixItems: WsInputItemDebugSummary[];
};

function stringifyStable(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyStable(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyStable(entry)}`)
    .join(",")}}`;
}

function payloadWithoutIncrementalFields(payload: ResponseCreateEvent): Record<string, unknown> {
  const {
    input: _input,
    metadata: _metadata,
    previous_response_id: _previousResponseId,
    ...rest
  } = payload;
  return rest;
}

function payloadFieldsMatch(left: ResponseCreateEvent, right: ResponseCreateEvent): boolean {
  return (
    stringifyStable(payloadWithoutIncrementalFields(left)) ===
    stringifyStable(payloadWithoutIncrementalFields(right))
  );
}

function inputItemsStartWith(input: InputItem[], baseline: InputItem[]): boolean {
  if (baseline.length > input.length) {
    return false;
  }
  return baseline.every((item, index) => stringifyStable(item) === stringifyStable(input[index]));
}

function summarizeInputItem(item: InputItem, index: number): WsInputItemDebugSummary {
  if (item.type === "message") {
    return {
      index,
      type: item.type,
      role: item.role,
      ...(item.phase ? { phase: item.phase } : {}),
      contentKind: typeof item.content === "string" ? "text" : "parts",
      contentLength: typeof item.content === "string" ? item.content.length : item.content.length,
    };
  }
  if (item.type === "function_call") {
    return {
      index,
      type: item.type,
      ...(item.id ? { id: item.id } : {}),
      ...(item.call_id ? { callId: item.call_id } : {}),
      name: item.name,
      argumentsLength: item.arguments.length,
    };
  }
  if (item.type === "function_call_output") {
    return {
      index,
      type: item.type,
      callId: item.call_id,
      outputLength: item.output.length,
    };
  }
  if (item.type === "reasoning") {
    return {
      index,
      type: item.type,
      ...(item.id ? { id: item.id } : {}),
      ...(item.encrypted_content ? { encryptedContentLength: item.encrypted_content.length } : {}),
    };
  }
  return {
    index,
    type: item.type,
    id: item.id,
  };
}

function buildRequestDebug(params: {
  mode: "full_context" | "incremental";
  previousResponseId?: string | null;
  baselineLength: number;
  fullInputItems: InputItem[];
  suffixItems: InputItem[];
}): PlannedWsRequestDebug {
  return {
    mode: params.mode,
    ...(params.previousResponseId ? { previousResponseId: params.previousResponseId } : {}),
    baselineLength: params.baselineLength,
    fullInputLength: params.fullInputItems.length,
    suffixLength: params.suffixItems.length,
    suffixItems: params.suffixItems.map((item, index) => summarizeInputItem(item, index)),
  };
}

export function planOpenAIWebSocketRequestPayload(params: {
  fullPayload: ResponseCreateEvent;
  previousRequestPayload?: ResponseCreateEvent;
  previousResponseId?: string | null;
  previousResponseInputItems?: InputItem[];
}): PlannedWsRequestPayload {
  const fullInputItems = Array.isArray(params.fullPayload.input) ? params.fullPayload.input : [];
  const previousInputItems = Array.isArray(params.previousRequestPayload?.input)
    ? params.previousRequestPayload.input
    : [];
  const previousResponseInputItems = params.previousResponseInputItems ?? [];

  if (
    params.previousResponseId &&
    params.previousRequestPayload &&
    payloadFieldsMatch(params.fullPayload, params.previousRequestPayload)
  ) {
    const baseline = [...previousInputItems, ...previousResponseInputItems];
    if (inputItemsStartWith(fullInputItems, baseline)) {
      const suffixItems = fullInputItems.slice(baseline.length);
      return {
        mode: "incremental",
        payload: {
          ...params.fullPayload,
          previous_response_id: params.previousResponseId,
          input: suffixItems,
        },
        debug: buildRequestDebug({
          mode: "incremental",
          previousResponseId: params.previousResponseId,
          baselineLength: baseline.length,
          fullInputItems,
          suffixItems,
        }),
      };
    }
  }

  const { previous_response_id: _previousResponseId, ...payload } = params.fullPayload;
  return {
    mode: "full_context",
    payload,
    debug: buildRequestDebug({
      mode: "full_context",
      previousResponseId: params.previousResponseId,
      baselineLength: previousInputItems.length + previousResponseInputItems.length,
      fullInputItems,
      suffixItems: fullInputItems,
    }),
  };
}

export function buildOpenAIWebSocketWarmUpPayload(params: {
  model: string;
  tools?: FunctionToolDefinition[];
  instructions?: string;
  metadata?: Record<string, string>;
}): WarmUpEvent {
  return {
    type: "response.create",
    generate: false,
    model: params.model,
    input: [],
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.instructions ? { instructions: params.instructions } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

export function buildOpenAIWebSocketResponseCreatePayload(params: {
  model: WsModel;
  context: WsContext;
  options?: WsOptions;
  turnInput: PlannedWsTurnInput;
  tools: FunctionToolDefinition[];
  metadata?: Record<string, string>;
}): ResponseCreateEvent {
  const extraParams: Record<string, unknown> = {};
  const streamOpts = params.options;

  if (streamOpts?.temperature !== undefined) {
    extraParams.temperature = streamOpts.temperature;
  }
  if (streamOpts?.maxTokens !== undefined) {
    extraParams.max_output_tokens = streamOpts.maxTokens;
  }
  if (streamOpts?.topP !== undefined) {
    extraParams.top_p = streamOpts.topP;
  }
  if (streamOpts?.toolChoice !== undefined) {
    extraParams.tool_choice = streamOpts.toolChoice;
  }

  const reasoningEffort = mapOpenAIReasoningEffortForModel({
    model: params.model,
    effort:
      streamOpts?.reasoningEffort ??
      streamOpts?.reasoning ??
      (params.model.reasoning ? "high" : undefined),
  });
  if (reasoningEffort || streamOpts?.reasoningSummary) {
    const reasoning: { effort?: string; summary?: string } = {};
    if (reasoningEffort !== undefined) {
      reasoning.effort = normalizeOpenAIReasoningEffort(reasoningEffort);
    }
    if (reasoningEffort !== "none" && streamOpts?.reasoningSummary !== undefined) {
      reasoning.summary = streamOpts.reasoningSummary;
    }
    extraParams.reasoning = reasoning;
    if (reasoning.effort && reasoning.effort !== "none") {
      extraParams.include = ["reasoning.encrypted_content"];
    }
  }

  const textVerbosity = resolveOpenAITextVerbosity(
    streamOpts as Record<string, unknown> | undefined,
  );
  if (textVerbosity !== undefined) {
    const existingText =
      extraParams.text && typeof extraParams.text === "object"
        ? (extraParams.text as Record<string, unknown>)
        : {};
    extraParams.text = { ...existingText, verbosity: textVerbosity };
  }

  const supportsResponsesStoreField = resolveProviderRequestPolicyConfig({
    provider: readStringValue(params.model.provider),
    api: readStringValue(params.model.api),
    baseUrl: readStringValue(params.model.baseUrl),
    compat: (params.model as { compat?: { supportsStore?: boolean } }).compat,
    capability: "llm",
    transport: "websocket",
  }).capabilities.supportsResponsesStoreField;

  return {
    type: "response.create",
    model: params.model.id,
    ...(supportsResponsesStoreField ? { store: false } : {}),
    input: params.turnInput.inputItems,
    instructions: params.context.systemPrompt
      ? stripSystemPromptCacheBoundary(params.context.systemPrompt)
      : undefined,
    tools: params.tools.length > 0 ? params.tools : undefined,
    ...(params.turnInput.previousResponseId
      ? { previous_response_id: params.turnInput.previousResponseId }
      : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...extraParams,
  };
}
