import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  composeProviderStreamWrappers,
  mergeTransportHeaders,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
  wrapProviderPayloadHook,
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

function normalizeXaiResponsesToolResultPayload(
  payloadObj: Record<string, unknown>,
  model: Parameters<StreamFn>[0],
): void {
  // The native API accepts call-bound media; retain the existing replay contract on other routes.
  if (
    model.api !== "openai-responses" ||
    isXaiEndpoint(model, XAI_BASE_URL) ||
    !Array.isArray(payloadObj.input)
  ) {
    return;
  }

  const includeImages = model.input.includes("image");
  let imageContentParts: Array<Record<string, unknown>> = [];
  let toolResultIndex = 0;
  const normalizedInput = payloadObj.input.flatMap((item: unknown, index, input) => {
    const itemObj = asOptionalRecord(item);
    if (itemObj?.type !== "function_call_output") {
      return [item];
    }
    // String outputs also occupy a result position, even though they carry no images.
    toolResultIndex += 1;
    let normalizedItem = item;
    if (Array.isArray(itemObj.output)) {
      const outputParts = itemObj.output as Array<Record<string, unknown>>;
      let textOutput = "";
      const imageStart = imageContentParts.length;
      for (const part of outputParts) {
        if (part.type === "input_text" && typeof part.text === "string") {
          textOutput += part.text;
        }
        if (includeImages && isReplayableInputImagePart(part)) {
          // Emit one ownership label before this result's first replayable image.
          if (imageContentParts.length === imageStart) {
            imageContentParts.push({
              type: "input_text",
              text: `Image(s) from tool result #${toolResultIndex}:`,
            });
          }
          imageContentParts.push(part);
        }
      }
      normalizedItem = {
        ...itemObj,
        output: textOutput || describeXaiFunctionOutputMediaPlaceholder(outputParts) || "",
      };
    }
    // Keep parallel outputs together, then anchor their images before later history.
    if (
      imageContentParts.length === 0 ||
      asOptionalRecord(input[index + 1])?.type === "function_call_output"
    ) {
      return [normalizedItem];
    }
    const carrier = { type: "message", role: "user", content: imageContentParts };
    imageContentParts = [];
    return [normalizedItem, carrier];
  });

  payloadObj.input = normalizedInput;
}

function createXaiToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    normalizeXaiResponsesToolResultPayload(payload, model);
  });
}

async function normalizeXaiGifPayload(payload: Record<string, unknown>) {
  const originalInput = payload.input;
  if (!Array.isArray(originalInput)) {
    return payload;
  }
  let input: unknown[] | undefined;
  for (let index = 0; index < originalInput.length; index += 1) {
    const record = asOptionalRecord(originalInput[index]);
    const key = record?.type === "function_call_output" ? "output" : "content";
    const parts = record?.[key];
    if (!Array.isArray(parts)) {
      continue;
    }
    let content: unknown[] | undefined;
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const image = asOptionalRecord(parts[partIndex]);
      if (image?.type !== "input_image") {
        continue;
      }
      const source = asOptionalRecord(image.source);
      const url =
        typeof image.image_url === "string"
          ? image.image_url
          : source?.type === "base64" &&
              typeof source.media_type === "string" &&
              typeof source.data === "string"
            ? `data:${source.media_type};base64,${source.data}`
            : undefined;
      const canonical = url && sanitizeInlineImageDataUrl(url);
      if (!canonical?.startsWith("data:image/gif;base64,")) {
        continue;
      }
      // Encode the first frame in this request projection, never in retained history.
      const { resizeToJpeg } = await import("openclaw/plugin-sdk/media-runtime");
      const bytes = await resizeToJpeg({
        buffer: Buffer.from(canonical.slice(canonical.indexOf(",") + 1), "base64"),
        maxSide: 1200,
        quality: 85,
      });
      const data = bytes.toString("base64");
      content ??= [...parts];
      content[partIndex] =
        typeof image.image_url === "string"
          ? { ...image, image_url: `data:image/jpeg;base64,${data}` }
          : { ...image, source: { ...source, media_type: "image/jpeg", data } };
    }
    if (content) {
      input ??= [...originalInput];
      input[index] = { ...record, [key]: content };
    }
  }
  return input ? { ...payload, input } : payload;
}

function createXaiGifCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isXaiProviderId(model.provider) || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      onPayload: wrapProviderPayloadHook(
        options?.onPayload,
        (payload, replacement) => {
          const selected = asOptionalRecord(replacement === undefined ? payload : replacement);
          return selected ? normalizeXaiGifPayload(selected) : replacement;
        },
        undefined,
        true,
      ),
    });
  };
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
    createXaiGifCompatibilityWrapper,
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
