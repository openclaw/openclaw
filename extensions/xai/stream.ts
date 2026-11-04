import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import { resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  composeProviderStreamWrappers,
  createEmptyTransportUsage,
  failTransportStream,
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

// xAI rejects GIF and other formats outside JPG/PNG/WebP/ICO, even within size limits.
// Other providers keep GIF pass-through; convert only xAI-bound requests, including replay.
const XAI_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const xaiJpegCache = new Map<string, string>();

type XaiImageBlock = { type: "image"; data: string; mimeType: string };

function needsXaiImageTranscode(block: unknown): block is XaiImageBlock {
  const image = asOptionalRecord(block);
  return (
    image?.type === "image" &&
    typeof image.data === "string" &&
    typeof image.mimeType === "string" &&
    (image.data.startsWith("R0lGOD") || !XAI_IMAGE_MIME_TYPES.has(image.mimeType.toLowerCase()))
  );
}

async function transcodeForXai(block: XaiImageBlock) {
  let jpeg = xaiJpegCache.get(block.data);
  if (jpeg === undefined) {
    const buffer = Buffer.from(block.data, "base64");
    jpeg = await resizeToJpeg({ buffer, maxSide: 4096, quality: 85, withoutEnlargement: true })
      .then((out) => out.toString("base64"))
      .catch(() => undefined);
    // Cache successes only; a transient encoder failure is retried on the next request.
    if (jpeg !== undefined) {
      const oldest = xaiJpegCache.size >= 64 ? xaiJpegCache.keys().next().value : undefined;
      if (oldest !== undefined) {
        xaiJpegCache.delete(oldest);
      }
      xaiJpegCache.set(block.data, jpeg);
    }
  }
  return jpeg === undefined
    ? {
        type: "text" as const,
        text: `[omitted image: could not convert ${block.mimeType} to a format xAI accepts; ask the user to resend it as PNG or JPEG]`,
      }
    : { ...block, data: jpeg, mimeType: "image/jpeg" };
}

const XAI_IMAGE_FORMAT_400 =
  /\b400\b[\s\S]*(valid JPG, PNG, WebP, or ICO image|image[\s\S]*(format|mime|type))/iu;
const omittedImage = {
  type: "text" as const,
  text: "[omitted image: xAI rejected this image format; ask the user to resend it as PNG or JPEG]",
};

// A format 400 that slips past conversion would poison every later turn; retry once with images omitted.
function createXaiImageFormatRetryWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const strip = (msg: (typeof context.messages)[number]) =>
      Array.isArray(msg.content) && msg.content.some((b) => b.type === "image")
        ? { ...msg, content: msg.content.map((b) => (b.type === "image" ? omittedImage : b)) }
        : msg;
    const messages = context.messages.map(strip);
    if (
      !isXaiProviderId(model.provider) ||
      messages.every((msg, i) => msg === context.messages[i])
    ) {
      return underlying(model, context, options);
    }
    const output = createAssistantMessageEventStream();
    void (async () => {
      // Hold "start" so a 400 before any content can be retried without the consumer seeing it.
      let start: AssistantMessageEvent | undefined;
      let sent = false;
      try {
        for await (const event of await underlying(model, context, options)) {
          if (!sent && event.type === "start") {
            start = event;
          } else if (
            !sent &&
            event.type === "error" &&
            XAI_IMAGE_FORMAT_400.test(event.error.errorMessage ?? "")
          ) {
            // SAFETY: only image blocks change, into text blocks every message role accepts.
            const retry = { ...context, messages: messages as typeof context.messages };
            for await (const retried of await underlying(model, retry, options)) {
              output.push(retried);
            }
            sent = true;
            break;
          } else {
            if (!sent && start) {
              output.push(start);
            }
            sent = true;
            output.push(event);
          }
        }
        if (!sent && start) {
          output.push(start);
        }
      } catch (error) {
        // Admission (first or retry) can reject before a stream exists; still settle the consumer.
        const usage = createEmptyTransportUsage();
        const failed = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "error" as const,
          timestamp: Date.now(),
        };
        return failTransportStream({
          stream: output,
          output: failed,
          signal: options?.signal,
          error,
        });
      }
      output.end();
    })();
    return output;
  };
}

function createXaiImageFormatWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = createXaiImageFormatRetryWrapper(baseStreamFn);
  return (model, context, options) => {
    const hasUnsupported =
      isXaiProviderId(model.provider) &&
      context.messages.some(
        (msg) => Array.isArray(msg.content) && msg.content.some(needsXaiImageTranscode),
      );
    if (!hasUnsupported) {
      return underlying(model, context, options);
    }
    return Promise.all(
      context.messages.map(async (msg) =>
        Array.isArray(msg.content) && msg.content.some(needsXaiImageTranscode)
          ? {
              ...msg,
              content: await Promise.all(
                msg.content.map((block) =>
                  needsXaiImageTranscode(block) ? transcodeForXai(block) : Promise.resolve(block),
                ),
              ),
            }
          : msg,
      ),
    ).then((messages) =>
      // SAFETY: only image blocks change, into image or text blocks every message role accepts.
      underlying(model, { ...context, messages: messages as typeof context.messages }, options),
    );
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

export function wrapXaiProviderStream(
  ctx: ProviderWrapStreamFnContext,
  runtime?: { clientVersion?: string },
): StreamFn | undefined {
  const extraParams = ctx.extraParams;
  const toolStreamEnabled = extraParams?.tool_stream !== false;
  return composeProviderStreamWrappers(
    ctx.streamFn,
    createXaiImageFormatWrapper,
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
