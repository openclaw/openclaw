import {
  generatedImageAssetFromBase64,
  inlineOpenAiCompatibleImageUrls,
  type GeneratedImageAsset,
  type ImageGenerationRequest,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
  sniffImageMimeType,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedImageDownloadMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertClawRouterImageResponseOk,
  assertClawRouterImageLimits,
  CLAWROUTER_IMAGE_CAPABILITIES,
  CLAWROUTER_GOOGLE_IMAGE_CAPABILITIES,
  CLAWROUTER_GOOGLE_IMAGE_MODELS,
  fetchClawRouterImageModels,
  isSupportedClawRouterImageModel,
  resolveClawRouterImageHttpContext,
} from "./image-model-catalog.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const GOOGLE_JSON_MAX_BYTES = 8 * 1024 * 1024;

function buildGoogleImageBody(req: ImageGenerationRequest): Record<string, unknown> {
  if ((req.count ?? 1) > 4 || (req.inputImages?.length ?? 0) > 5) {
    throw new Error("ClawRouter Google images support at most 4 outputs and 5 reference images.");
  }
  if (
    req.size ||
    req.aspectRatio ||
    req.resolution ||
    req.quality ||
    req.outputFormat ||
    req.background ||
    (req.providerOptions && Object.keys(req.providerOptions).length)
  ) {
    throw new Error(
      "Unsupported ClawRouter Google image options; use a prompt and optional reference images.",
    );
  }
  const inputParts = (req.inputImages ?? []).map((image) => {
    if (
      !image.buffer.length ||
      image.buffer.length > GOOGLE_JSON_MAX_BYTES ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) ||
      sniffImageMimeType(image.buffer, "").mimeType !== image.mimeType
    ) {
      throw new Error(
        "ClawRouter Google reference images must be bounded PNG, JPEG or WebP images.",
      );
    }
    return { inlineData: { mimeType: image.mimeType, data: image.buffer.toString("base64") } };
  });
  const body = {
    contents: [{ role: "user", parts: [...inputParts, { text: req.prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
  if (Buffer.byteLength(JSON.stringify(body)) > GOOGLE_JSON_MAX_BYTES) {
    throw new Error("ClawRouter Google image request exceeds the 8 MiB JSON limit.");
  }
  return body;
}

function parseGoogleImageResponse(payload: unknown): GeneratedImageAsset[] {
  const fail = (): never => {
    throw new Error("ClawRouter Google image generation response malformed");
  };
  const body = asOptionalRecord(payload);
  const feedback = asOptionalRecord(body?.promptFeedback);
  if (
    !body ||
    body.error !== undefined ||
    (feedback?.blockReason !== undefined && feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") ||
    !Array.isArray(body.candidates)
  ) {
    return fail();
  }
  const images: GeneratedImageAsset[] = [];
  let bytes = 0;
  for (const value of body.candidates) {
    const candidate = asOptionalRecord(value);
    const content = asOptionalRecord(candidate?.content);
    if (candidate?.finishReason !== "STOP" || !Array.isArray(content?.parts)) {
      return fail();
    }
    for (const partValue of content.parts) {
      const part = asOptionalRecord(partValue);
      if (
        !part ||
        part.fileData !== undefined ||
        part.file_data !== undefined ||
        (part.inlineData !== undefined && part.inline_data !== undefined)
      ) {
        return fail();
      }
      if (part.thought === true) {
        continue;
      }
      if (part.inlineData === undefined && part.inline_data === undefined) {
        if (typeof part.text !== "string") {
          return fail();
        }
        continue;
      }
      const inline = asOptionalRecord(part.inlineData ?? part.inline_data);
      const mimeType = inline?.mimeType ?? inline?.mime_type;
      if (
        !inline ||
        (inline.mimeType !== undefined && inline.mime_type !== undefined) ||
        typeof inline.data !== "string" ||
        typeof mimeType !== "string" ||
        !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
      ) {
        return fail();
      }
      const image = generatedImageAssetFromBase64({
        base64: inline.data,
        mimeType,
        index: images.length,
      });
      if (!image || image.buffer.toString("base64") !== inline.data) {
        return fail();
      }
      bytes += image.buffer.length;
      if (bytes > 4 * 1024 * 1024 || images.length >= 4) {
        return fail();
      }
      images.push(image);
    }
  }
  return images;
}

export function buildClawRouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    // No credential-independent models/default: callers select an entitled live row.
    models: [],
    capabilities: {
      ...CLAWROUTER_IMAGE_CAPABILITIES,
      edit: {
        ...CLAWROUTER_GOOGLE_IMAGE_CAPABILITIES.edit,
        // The provider-wide edit flag is not a grant to edit with OpenAI/unknown models.
        maxInputImages: 0,
        maxInputImagesByModel: Object.fromEntries(
          CLAWROUTER_GOOGLE_IMAGE_MODELS.map((model) => [model, 5]),
        ),
      },
      output: {
        ...CLAWROUTER_IMAGE_CAPABILITIES.output,
        qualitiesByModel: Object.fromEntries(
          CLAWROUTER_GOOGLE_IMAGE_MODELS.map((model) => [model, []]),
        ),
        formatsByModel: Object.fromEntries(
          CLAWROUTER_GOOGLE_IMAGE_MODELS.map((model) => [model, []]),
        ),
        backgroundsByModel: Object.fromEntries(
          CLAWROUTER_GOOGLE_IMAGE_MODELS.map((model) => [model, []]),
        ),
      },
    },
    async generateImage(req) {
      const google = CLAWROUTER_GOOGLE_IMAGE_MODELS.includes(req.model);
      if (!google && req.inputImages?.length) {
        throw new Error("ClawRouter image editing is not supported.");
      }
      if (!isSupportedClawRouterImageModel(req.model)) {
        throw new Error(
          "Unsupported ClawRouter image model; select a qualified model from the image catalog.",
        );
      }
      if (!req.prompt.trim() || Array.from(req.prompt).length > 32_000) {
        throw new Error("ClawRouter image prompt must contain 1–32000 characters.");
      }
      const requestedCount = req.count ?? 1;
      if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 10) {
        throw new Error("ClawRouter image count must be an integer from 1 to 10.");
      }
      const options = req.providerOptions;
      if (options && Object.keys(options).some((key) => key !== "openai")) {
        throw new Error("Unsupported ClawRouter image options; only JSON generation is supported.");
      }
      const openai = asOptionalRecord(options?.openai);
      if (
        openai &&
        Object.keys(openai).some(
          (key) => !["background", "moderation", "outputCompression", "user"].includes(key),
        )
      ) {
        throw new Error(
          "Unsupported ClawRouter image option; edits, masks, variations and streaming are not supported.",
        );
      }
      let body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        n: requestedCount,
      };
      const optional = {
        size: req.size,
        quality: req.quality,
        output_format: req.outputFormat,
        background: req.background ?? openai?.background,
        moderation: openai?.moderation,
        output_compression: openai?.outputCompression,
        user: openai?.user,
      };
      for (const [key, value] of Object.entries(optional)) {
        if (value !== undefined) {
          body[key] = value;
        }
      }
      if (google) {
        body = buildGoogleImageBody(req);
      }
      req.signal?.throwIfAborted();
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        label: "ClawRouter image generation",
      });
      const remainingTimeoutMs = () =>
        resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      const auth = await resolveApiKeyForProvider({
        provider: "clawrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
        modelId: req.model,
        capability: "image",
        signal: req.signal,
      });
      if (!auth.apiKey) {
        throw new Error(
          "ClawRouter key missing. Configure ClawRouter; upstream OpenAI credentials are not used.",
        );
      }
      const context = resolveClawRouterImageHttpContext(req, auth.apiKey);
      const catalog = await fetchClawRouterImageModels({
        context,
        timeoutMs: remainingTimeoutMs,
        signal: req.signal,
        ssrfPolicy: req.ssrfPolicy,
      });
      const selected = catalog.find((row) => row.model === req.model);
      if (!selected) {
        throw new Error(
          "ClawRouter image model is not available in this key's current catalog; check the deployment, image grants and budget.",
        );
      }
      if (selected.format === "openai") {
        assertClawRouterImageLimits(req, selected.limits);
      }
      req.signal?.throwIfAborted();
      const headers = new Headers(context.headers);
      headers.set("Content-Type", "application/json");
      const url = selected.url;
      const { response, release } = await postJsonRequest({
        url,
        headers,
        body,
        fetchFn: fetch,
        timeoutMs: remainingTimeoutMs(),
        signal: req.signal,
        allowPrivateNetwork: context.allowPrivateNetwork,
        ssrfPolicy: mergeSsrFPolicies(req.ssrfPolicy, context.ssrfPolicy),
        dispatcherPolicy: context.dispatcherPolicy,
      });
      try {
        assertClawRouterImageResponseOk(response, "ClawRouter image generation");
        // Gemini has no native count parameter. Retain all (at most four) returned images.
        const count = google ? 4 : requestedCount;
        const maxBytes = resolveGeneratedImageDownloadMaxBytes(req.cfg);
        const payload = await readProviderJsonResponse(response, "clawrouter.image-generation", {
          maxBytes: google
            ? GOOGLE_JSON_MAX_BYTES
            : resolveInlineImageJsonResponseMaxBytes(count, maxBytes),
          timeoutMs: remainingTimeoutMs,
        });
        const inline = google
          ? undefined
          : await inlineOpenAiCompatibleImageUrls(payload, {
              providerId: "clawrouter",
              label: "ClawRouter",
              operation: "ClawRouter image generation",
              providerUrl: url,
              maxDownloads: count,
              maxBytes,
              timeoutMs: remainingTimeoutMs,
              signal: req.signal,
              allowPrivateNetwork: context.allowPrivateNetwork,
              ssrfPolicy: req.ssrfPolicy,
              dispatcherPolicy: context.dispatcherPolicy,
            });
        const images = google
          ? parseGoogleImageResponse(payload)
          : parseOpenAiCompatibleImageResponse(inline, {
              sniffMimeType: true,
              malformedResponseError: "ClawRouter image generation response malformed",
            });
        if (!images.length || images.length > count) {
          throw new Error("ClawRouter image generation returned an invalid image count.");
        }
        for (const image of images) {
          if (image.buffer.byteLength > maxBytes) {
            throw new Error("ClawRouter generated image exceeds the download size limit.");
          }
          const detected = sniffImageMimeType(image.buffer, "");
          if (!detected.mimeType || image.mimeType !== detected.mimeType) {
            throw new Error(
              "ClawRouter image generation returned invalid image content or MIME type.",
            );
          }
        }
        req.signal?.throwIfAborted();
        return { images, model: req.model };
      } finally {
        void response.body?.cancel().catch(() => undefined);
        await release();
      }
    },
  };
}
