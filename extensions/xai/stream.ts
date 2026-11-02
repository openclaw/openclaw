import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  mergeTransportHeaders,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asOptionalRecord, filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
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

const XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE = "reasoning.encrypted_content";

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
    if (!model.reasoning || asOptionalRecord(model.compat)?.supportsReasoningEffort === false) {
      // Only current flagship Grok models advertise configurable effort.
      delete payload.reasoning;
      delete payload.reasoningEffort;
      delete payload.reasoning_effort;
    }
    // All reasoning xAI models should still request + later replay encrypted_content.
    if (!isXaiProviderId(model.provider) || model.api !== "openai-responses" || !model.reasoning) {
      return;
    }
    const existing = payload.include;
    const include = filterStringEntries(existing);
    if (!include.includes(XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE)) {
      include.push(XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE);
    }
    payload.include = include;
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
