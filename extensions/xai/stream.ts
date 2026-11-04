import { createHash } from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  composeProviderStreamWrappers,
  mergeTransportHeaders,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveXaiFastModelId } from "./fast-mode.js";
import { XAI_BASE_URL } from "./model-definitions.js";
import { isXaiGrokProxyBaseUrl } from "./provider-catalog.js";
import { isXaiProviderId } from "./provider-id.js";

function isXaiEndpoint(model: Parameters<StreamFn>[0], endpoint: string): boolean {
  return isXaiProviderId(model.provider) && model.baseUrl?.trim().replace(/\/+$/u, "") === endpoint;
}

function createXaiGrokOAuthHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  clientVersion: string | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const normalizedClientVersion = clientVersion?.trim();
  return (model, context, options) => {
    if (
      !normalizedClientVersion ||
      !isXaiProviderId(model.provider) ||
      !isXaiGrokProxyBaseUrl(model.baseUrl)
    ) {
      return underlying(model, context, options);
    }
    // The Grok OAuth proxy requires its CLI identity and a concrete catalog model.
    // Keep these proxy-only so ordinary xAI API-key traffic retains its public contract.
    return underlying(model, context, {
      ...options,
      headers: mergeTransportHeaders(options?.headers, {
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-client-version": normalizedClientVersion,
        "x-grok-model-override": model.id,
      }),
    });
  };
}

const xaiReasoning = buildProviderStreamFamilyHooks("xai-responses-reasoning");

function isReplayableInputImagePart(part: Record<string, unknown>): boolean {
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

function describeXaiFunctionOutputMediaPlaceholder(
  parts: Array<Record<string, unknown>>,
): string | undefined {
  let hasImage = false;
  let hasAudio = false;
  let hasOtherMedia = false;

  for (const part of parts) {
    const type = typeof part.type === "string" ? part.type : "";
    const mimeType =
      typeof part.mimeType === "string"
        ? part.mimeType
        : typeof part.mime_type === "string"
          ? part.mime_type
          : typeof part.mediaType === "string"
            ? part.mediaType
            : typeof part.contentType === "string"
              ? part.contentType
              : "";
    const normalizedMime = mimeType.toLowerCase();
    if (type.includes("image") || normalizedMime.startsWith("image/")) {
      hasImage = true;
    } else if (type.includes("audio") || normalizedMime.startsWith("audio/")) {
      hasAudio = true;
    } else if (type !== "input_text") {
      hasOtherMedia = true;
    }
  }

  if ((hasImage && hasAudio) || hasOtherMedia) {
    return "(see attached media)";
  }
  if (hasAudio) {
    return "(see attached audio)";
  }
  if (hasImage) {
    return "(see attached image)";
  }
  return undefined;
}

function isGifImagePart(part: Record<string, unknown>): boolean {
  if (part.type !== "input_image") {
    return false;
  }
  if (typeof part.image_url === "string") {
    const url = part.image_url.toLowerCase();
    return url.startsWith("data:image/gif;") || url.includes("base64,r0lgod");
  }
  const source = asOptionalRecord(part.source);
  if (source) {
    const mediaType = typeof source.media_type === "string" ? source.media_type.toLowerCase() : "";
    const data = typeof source.data === "string" ? source.data : "";
    return mediaType === "image/gif" || data.startsWith("R0lGOD");
  }
  return false;
}

const MAX_CONVERTED_GIF_ENTRIES = 50;
const convertedGifCache = new Map<string, string>();
const GIF_OMISSION_TEXT =
  "[omitted image payload: unsupported GIF conversion failed; please provide a PNG or JPEG instead]";

async function normalizeXaiImagePart(
  part: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isGifImagePart(part)) {
    return part;
  }
  let base64 = "";
  let isDataUrl = false;
  const rawImageUrl = part.image_url;
  if (typeof rawImageUrl === "string") {
    const comma = rawImageUrl.indexOf(",");
    base64 = comma !== -1 ? rawImageUrl.slice(comma + 1) : "";
    isDataUrl = true;
  } else {
    const source = asOptionalRecord(part.source);
    if (source && typeof source.data === "string") {
      base64 = source.data;
    }
  }

  if (!base64.trim()) {
    return { type: "input_text", text: GIF_OMISSION_TEXT };
  }

  try {
    const cacheKey = createHash("sha256").update(base64).digest("hex");
    let jpegBase64 = convertedGifCache.get(cacheKey);
    if (!jpegBase64) {
      const buffer = Buffer.from(base64, "base64");
      const encoded = await resizeToJpeg({
        buffer,
        maxSide: 2048,
        quality: 85,
        withoutEnlargement: true,
      });
      jpegBase64 = encoded.toString("base64");
      if (convertedGifCache.size >= MAX_CONVERTED_GIF_ENTRIES) {
        const oldestKey = convertedGifCache.keys().next().value;
        if (oldestKey !== undefined) {
          convertedGifCache.delete(oldestKey);
        }
      }
      convertedGifCache.set(cacheKey, jpegBase64);
    }

    if (isDataUrl) {
      return {
        ...part,
        image_url: `data:image/jpeg;base64,${jpegBase64}`,
      };
    }
    const source = asOptionalRecord(part.source) ?? {};
    return {
      ...part,
      source: {
        ...source,
        type: "base64",
        media_type: "image/jpeg",
        data: jpegBase64,
      },
    };
  } catch {
    return { type: "input_text", text: GIF_OMISSION_TEXT };
  }
}

function hasGifImageParts(input: unknown[]): boolean {
  for (const item of input) {
    const itemObj = asOptionalRecord(item);
    if (itemObj?.type === "message" && Array.isArray(itemObj.content)) {
      for (const part of itemObj.content) {
        const partObj = asOptionalRecord(part);
        if (partObj && isGifImagePart(partObj)) {
          return true;
        }
      }
    } else if (itemObj?.type === "function_call_output" && Array.isArray(itemObj.output)) {
      for (const part of itemObj.output) {
        const partObj = asOptionalRecord(part);
        if (partObj && isGifImagePart(partObj)) {
          return true;
        }
      }
    }
  }
  return false;
}

async function transformPayloadInput(
  payloadObj: Record<string, unknown>,
  model: Parameters<StreamFn>[0],
  isNative: boolean,
  isAsync: boolean,
): Promise<void> {
  const includeImages = model.input.includes("image");
  let imageContentParts: Array<Record<string, unknown>> = [];
  let toolResultIndex = 0;

  if (!Array.isArray(payloadObj.input)) {
    return;
  }
  const inputList = payloadObj.input;
  const normalizedInput: unknown[] = [];

  for (let index = 0; index < inputList.length; index += 1) {
    const item = inputList[index];
    const itemObj = asOptionalRecord(item);

    if (itemObj?.type === "message" && Array.isArray(itemObj.content)) {
      if (isAsync) {
        let hasGifInMessage = false;
        for (const rawPart of itemObj.content) {
          const part = asOptionalRecord(rawPart);
          if (part && isGifImagePart(part)) {
            hasGifInMessage = true;
            break;
          }
        }
        if (hasGifInMessage) {
          const normalizedParts: unknown[] = [];
          for (const rawPart of itemObj.content) {
            const part = asOptionalRecord(rawPart);
            if (part && isGifImagePart(part)) {
              normalizedParts.push(await normalizeXaiImagePart(part));
            } else {
              normalizedParts.push(rawPart);
            }
          }
          normalizedInput.push({ ...itemObj, content: normalizedParts });
          continue;
        }
      }
      normalizedInput.push(item);
      continue;
    }

    if (itemObj?.type !== "function_call_output") {
      normalizedInput.push(item);
      continue;
    }

    toolResultIndex += 1;
    let normalizedItem = item;

    if (Array.isArray(itemObj.output)) {
      const outputParts = itemObj.output as Array<Record<string, unknown>>;
      let textOutput = "";
      const imageStart = imageContentParts.length;

      const normalizedOutputParts: Array<Record<string, unknown>> = [];
      for (const rawPart of outputParts) {
        const part =
          isAsync && isGifImagePart(rawPart) ? await normalizeXaiImagePart(rawPart) : rawPart;
        normalizedOutputParts.push(part);

        if (part.type === "input_text" && typeof part.text === "string") {
          textOutput += part.text;
        }
        if (includeImages && isReplayableInputImagePart(part)) {
          if (!isNative) {
            if (imageContentParts.length === imageStart) {
              imageContentParts.push({
                type: "input_text",
                text: `Image(s) from tool result #${toolResultIndex}:`,
              });
            }
            imageContentParts.push(part);
          }
        }
      }

      if (isNative) {
        normalizedItem = {
          ...itemObj,
          output: normalizedOutputParts,
        };
      } else {
        normalizedItem = {
          ...itemObj,
          output:
            textOutput || describeXaiFunctionOutputMediaPlaceholder(normalizedOutputParts) || "",
        };
      }
    }

    if (isNative) {
      normalizedInput.push(normalizedItem);
      continue;
    }

    if (
      imageContentParts.length === 0 ||
      asOptionalRecord(inputList[index + 1])?.type === "function_call_output"
    ) {
      normalizedInput.push(normalizedItem);
      continue;
    }

    const carrier = { type: "message", role: "user", content: imageContentParts };
    imageContentParts = [];
    normalizedInput.push(normalizedItem, carrier);
  }

  if (
    normalizedInput.length !== inputList.length ||
    normalizedInput.some((val, i) => val !== inputList[i])
  ) {
    payloadObj.input = normalizedInput;
  }
}

function normalizeXaiResponsesToolResultPayload(
  payloadObj: Record<string, unknown>,
  model: Parameters<StreamFn>[0],
): void | Promise<void> {
  // The native API accepts call-bound media; retain the existing replay contract on other routes.
  if (model.api !== "openai-responses" || !Array.isArray(payloadObj.input)) {
    return;
  }

  const isNative = isXaiEndpoint(model, XAI_BASE_URL);
  const hasGifs = hasGifImageParts(payloadObj.input);

  if (isNative && !hasGifs) {
    return;
  }

  if (hasGifs) {
    return transformPayloadInput(payloadObj, model, isNative, true);
  }

  void transformPayloadInput(payloadObj, model, isNative, false);
}

function createXaiToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    return normalizeXaiResponsesToolResultPayload(payload, model);
  });
}

export function wrapXaiProviderStream(
  ctx: ProviderWrapStreamFnContext,
  runtime?: { clientVersion?: string },
): StreamFn | undefined {
  const extraParams = ctx.extraParams;
  const toolStreamEnabled = extraParams?.tool_stream !== false;
  return composeProviderStreamWrappers(
    ctx.streamFn,
    (streamFn) => createXaiGrokOAuthHeadersWrapper(streamFn, runtime?.clientVersion),
    (streamFn) => xaiReasoning.wrapStreamFn?.({ ...ctx, streamFn }) ?? streamFn ?? streamSimple,
    createXaiToolPayloadCompatibilityWrapper,
    Boolean(
      extraParams &&
      (Object.hasOwn(extraParams, "fastMode") || Object.hasOwn(extraParams, "fast_mode")),
    ) &&
      ((streamFn) => {
        const underlying = streamFn ?? streamSimple;
        return (model, context, options) => {
          const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
          const resolved = typeof raw === "function" ? (raw as () => unknown)() : raw;
          if (resolved !== true && resolved !== "ultrafast") {
            return underlying(model, context, options);
          }

          const fastModelId = resolveXaiFastModelId(model);
          if (!fastModelId) {
            return underlying(model, context, options);
          }

          return underlying({ ...model, id: fastModelId }, context, options);
        };
      }),
    createPlainTextToolCallCompatWrapper,
    (streamFn) => createToolStreamWrapper(streamFn, toolStreamEnabled),
  );
}
