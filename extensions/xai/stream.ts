// Xai plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);
const XAI_WEB_SEARCH_TOOL = { type: "web_search" } as const;

function resolveXaiFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return XAI_FAST_MODEL_IDS.get(modelId.trim());
}

function stripUnsupportedStrictFlag(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") {
    return tool;
  }
  const toolObj = tool as Record<string, unknown>;
  const fn = toolObj.function;
  if (!fn || typeof fn !== "object") {
    return tool;
  }
  const fnObj = fn as Record<string, unknown>;
  if (typeof fnObj.strict !== "boolean") {
    return tool;
  }
  const nextFunction = { ...fnObj };
  delete nextFunction.strict;
  return { ...toolObj, function: nextFunction };
}

type XaiNativeWebSearchOptions = {
  config?: unknown;
  nativeWebSearchAllowedByToolPolicy?: boolean;
};

function readNativeWebSearchAllowedByToolPolicy(
  ctx: ProviderWrapStreamFnContext,
): boolean | undefined {
  return (ctx as { nativeWebSearchAllowedByToolPolicy?: boolean })
    .nativeWebSearchAllowedByToolPolicy;
}

function isXaiResponsesWebSearchTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  return (tool as Record<string, unknown>).type === "web_search";
}

function isManagedWebSearchFunctionTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  const toolObj = tool as Record<string, unknown>;
  if (toolObj.type !== "function") {
    return false;
  }
  if (toolObj.name === "web_search") {
    return true;
  }
  const fn = toolObj.function;
  return (
    Boolean(fn) && typeof fn === "object" && (fn as Record<string, unknown>).name === "web_search"
  );
}

function readWebSearchConfig(config: unknown): Record<string, unknown> | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const tools = (config as Record<string, unknown>).tools;
  if (!tools || typeof tools !== "object") {
    return undefined;
  }
  const web = (tools as Record<string, unknown>).web;
  if (!web || typeof web !== "object") {
    return undefined;
  }
  const search = (web as Record<string, unknown>).search;
  return search && typeof search === "object" ? (search as Record<string, unknown>) : undefined;
}

function shouldUseXaiNativeWebSearchProvider(config: unknown): boolean {
  const search = readWebSearchConfig(config);
  if (search?.enabled === false) {
    return false;
  }
  if (typeof search?.provider !== "string") {
    return true;
  }
  const provider = search.provider.trim().toLowerCase();
  return provider === "" || provider === "auto" || provider === "grok";
}

function normalizeXaiWebSearchToolChoice(payloadObj: Record<string, unknown>): void {
  const choice = payloadObj.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    return;
  }
  const choiceObj = choice as Record<string, unknown>;
  if (isManagedWebSearchFunctionTool(choiceObj)) {
    payloadObj.tool_choice = XAI_WEB_SEARCH_TOOL;
    return;
  }
  if (choiceObj.type !== "allowed_tools" || !Array.isArray(choiceObj.tools)) {
    return;
  }

  let changed = false;
  let hasNativeWebSearch = false;
  const tools: unknown[] = [];
  for (const tool of choiceObj.tools) {
    if (isManagedWebSearchFunctionTool(tool)) {
      changed = true;
      if (!hasNativeWebSearch) {
        tools.push(XAI_WEB_SEARCH_TOOL);
        hasNativeWebSearch = true;
      }
      continue;
    }
    if (isXaiResponsesWebSearchTool(tool)) {
      if (hasNativeWebSearch) {
        changed = true;
        continue;
      }
      hasNativeWebSearch = true;
    }
    tools.push(tool);
  }
  if (!changed) {
    return;
  }
  payloadObj.tool_choice = { ...choiceObj, tools };
}

function normalizeXaiResponsesWebSearchTools(
  payloadObj: Record<string, unknown>,
  model: { api?: unknown },
  options?: XaiNativeWebSearchOptions,
): void {
  if (model.api !== "openai-responses") {
    return;
  }
  const nativeWebSearchAllowedByPolicy = options?.nativeWebSearchAllowedByToolPolicy !== false;
  const shouldUseNativeWebSearch =
    nativeWebSearchAllowedByPolicy && shouldUseXaiNativeWebSearchProvider(options?.config);
  if (!shouldUseNativeWebSearch) {
    return;
  }

  const existingTools = Array.isArray(payloadObj.tools) ? payloadObj.tools : [];
  const filteredTools = existingTools.filter((tool) => !isManagedWebSearchFunctionTool(tool));
  const hasManagedWebSearch = filteredTools.length !== existingTools.length;
  const hasNativeWebSearch = filteredTools.some(isXaiResponsesWebSearchTool);

  if (!hasManagedWebSearch) {
    return;
  }

  payloadObj.tools = hasNativeWebSearch ? filteredTools : [...filteredTools, XAI_WEB_SEARCH_TOOL];
  normalizeXaiWebSearchToolChoice(payloadObj);
}

function supportsExplicitImageInput(model: { input?: unknown }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function supportsReasoningControls(model: { compat?: unknown; reasoning?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsReasoningEffort?: unknown })
      : undefined;
  return model.reasoning === true && compat?.supportsReasoningEffort !== false;
}

const TOOL_RESULT_IMAGE_REPLAY_TEXT = "Attached image(s) from tool result:";

type ReplayableInputImagePart =
  | {
      type: "input_image";
      source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string };
    }
  | { type: "input_image"; image_url: string; detail?: string };

type NormalizedFunctionCallOutput = {
  normalizedItem: unknown;
  imageParts: Array<Record<string, unknown>>;
};

function isReplayableInputImagePart(
  part: Record<string, unknown>,
): part is ReplayableInputImagePart {
  if (part.type !== "input_image") {
    return false;
  }
  if (typeof part.image_url === "string") {
    return true;
  }
  if (!part.source || typeof part.source !== "object") {
    return false;
  }
  const source = part.source as {
    type?: unknown;
    url?: unknown;
    media_type?: unknown;
    data?: unknown;
  };
  if (source.type === "url") {
    return typeof source.url === "string";
  }
  return (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  );
}

function normalizeXaiResponsesFunctionCallOutput(
  item: unknown,
  includeImages: boolean,
): NormalizedFunctionCallOutput {
  if (!item || typeof item !== "object") {
    return { normalizedItem: item, imageParts: [] };
  }

  const itemObj = item as Record<string, unknown>;
  if (itemObj.type !== "function_call_output" || !Array.isArray(itemObj.output)) {
    return { normalizedItem: itemObj, imageParts: [] };
  }

  const outputParts = itemObj.output as Array<Record<string, unknown>>;
  const textOutput = outputParts
    .filter(
      (part): part is { type: "input_text"; text: string } =>
        part.type === "input_text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");

  const imageParts = includeImages
    ? outputParts.filter((part): part is ReplayableInputImagePart =>
        isReplayableInputImagePart(part),
      )
    : [];
  const hadNonTextParts = outputParts.some((part) => part.type !== "input_text");

  return {
    normalizedItem: {
      ...itemObj,
      output: textOutput || (hadNonTextParts ? "(see attached image)" : ""),
    },
    imageParts,
  };
}

function normalizeXaiResponsesToolResultPayload(
  payloadObj: Record<string, unknown>,
  model: { api?: unknown; input?: unknown },
): void {
  if (model.api !== "openai-responses" || !Array.isArray(payloadObj.input)) {
    return;
  }

  const includeImages = supportsExplicitImageInput(model);
  const normalizedInput: unknown[] = [];
  const collectedImageParts: Array<Record<string, unknown>> = [];

  for (const item of payloadObj.input) {
    const normalized = normalizeXaiResponsesFunctionCallOutput(item, includeImages);
    normalizedInput.push(normalized.normalizedItem);
    collectedImageParts.push(...normalized.imageParts);
  }

  if (collectedImageParts.length > 0) {
    normalizedInput.push({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: TOOL_RESULT_IMAGE_REPLAY_TEXT },
        ...collectedImageParts,
      ],
    });
  }

  payloadObj.input = normalizedInput;
}

export function createXaiToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  wrapperOptions?: XaiNativeWebSearchOptions,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, streamOptions) => {
    const originalOnPayload = streamOptions?.onPayload;
    return underlying(model, context, {
      ...streamOptions,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map((tool) => stripUnsupportedStrictFlag(tool));
          }
          normalizeXaiResponsesWebSearchTools(payloadObj, model, wrapperOptions);
          normalizeXaiResponsesToolResultPayload(payloadObj, model);
          if (!supportsReasoningControls(model)) {
            delete payloadObj.reasoning;
            delete payloadObj.reasoningEffort;
            delete payloadObj.reasoning_effort;
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createXaiFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const supportsFastAliasTransport =
      model.api === "openai-completions" || model.api === "openai-responses";
    if (!fastMode || !supportsFastAliasTransport || model.provider !== "xai") {
      return underlying(model, context, options);
    }

    const fastModelId = resolveXaiFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

export function wrapXaiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const extraParams = ctx.extraParams;
  const fastMode = extraParams?.fastMode;
  const toolStreamEnabled = extraParams?.tool_stream !== false;
  return composeProviderStreamWrappers(ctx.streamFn, (streamFn) => {
    let wrappedStreamFn = createXaiToolPayloadCompatibilityWrapper(streamFn, {
      config: ctx.config,
      nativeWebSearchAllowedByToolPolicy: readNativeWebSearchAllowedByToolPolicy(ctx),
    });
    if (typeof fastMode === "boolean") {
      wrappedStreamFn = createXaiFastModeWrapper(wrappedStreamFn, fastMode);
    }
    wrappedStreamFn = createPlainTextToolCallCompatWrapper(wrappedStreamFn);
    return createToolStreamWrapper(wrappedStreamFn, toolStreamEnabled);
  });
}
