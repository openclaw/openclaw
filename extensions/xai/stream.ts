import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);

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

function supportsExplicitImageInput(model: { input?: unknown }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
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
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map((tool) => stripUnsupportedStrictFlag(tool));
          }
          normalizeXaiResponsesToolResultPayload(payloadObj, model);
          delete payloadObj.reasoning;
          delete payloadObj.reasoningEffort;
          delete payloadObj.reasoning_effort;
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

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&#60;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#62;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&");
}

function decodeHtmlEntitiesInObject(value: unknown): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeHtmlEntitiesInObject(entry));
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    record[key] = decodeHtmlEntitiesInObject(entry);
  }
  return record;
}

function decodeXaiToolCallArgumentsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      continue;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  }
}

function wrapStreamDecodeXaiToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    decodeXaiToolCallArgumentsInMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            decodeXaiToolCallArgumentsInMessage(event.partial);
            decodeXaiToolCallArgumentsInMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}

export function createXaiToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseStreamFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamDecodeXaiToolCallArguments(stream),
      );
    }
    return wrapStreamDecodeXaiToolCallArguments(maybeStream);
  };
}

export function wrapXaiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const extraParams = ctx.extraParams;
  const fastMode = extraParams?.fastMode;
  const toolStreamEnabled = extraParams?.tool_stream !== false;
  return composeProviderStreamWrappers(ctx.streamFn, (streamFn) => {
    let wrappedStreamFn = createXaiToolPayloadCompatibilityWrapper(streamFn);
    if (typeof fastMode === "boolean") {
      wrappedStreamFn = createXaiFastModeWrapper(wrappedStreamFn, fastMode);
    }
    wrappedStreamFn = createXaiToolCallArgumentDecodingWrapper(wrappedStreamFn);
    return createToolStreamWrapper(wrappedStreamFn, toolStreamEnabled);
  });
}
