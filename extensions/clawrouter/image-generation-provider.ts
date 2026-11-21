import {
  inlineOpenAiCompatibleImageUrls,
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
  fetchClawRouterImageModels,
  isSupportedClawRouterImageModel,
  resolveClawRouterImageHttpContext,
} from "./image-model-catalog.js";

const DEFAULT_TIMEOUT_MS = 180_000;
// ClawRouter's JSON Images API ingress cap includes base64 references and all options.
const MAX_EDIT_REQUEST_BYTES = 8 * 1024 * 1024;

export function buildClawRouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    // No credential-independent models/default: callers select an entitled live row.
    models: [],
    capabilities: CLAWROUTER_IMAGE_CAPABILITIES,
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const mode = inputImages.length ? "edit" : "generate";
      if (!isSupportedClawRouterImageModel(req.model)) {
        throw new Error(
          "Unsupported ClawRouter image model; select a qualified flare/sunburst model from the image catalog.",
        );
      }
      if (!req.prompt.trim() || Array.from(req.prompt).length > 32_000) {
        throw new Error("ClawRouter image prompt must contain 1–32000 characters.");
      }
      if (inputImages.length > 16) {
        throw new Error("ClawRouter image editing supports at most 16 reference images.");
      }
      if (inputImages.some((image) => image.buffer.byteLength > 4 * 1024 * 1024)) {
        throw new Error("ClawRouter reference images must not exceed 4 MiB each.");
      }
      if (
        inputImages.reduce(
          (bytes, image) => bytes + 4 * Math.ceil(image.buffer.byteLength / 3),
          0,
        ) > MAX_EDIT_REQUEST_BYTES
      ) {
        throw new Error("ClawRouter image edit request exceeds the 8 MiB JSON size limit.");
      }
      for (const image of inputImages) {
        const detected = sniffImageMimeType(image.buffer, "");
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(detected.mimeType) ||
          image.mimeType !== detected.mimeType
        ) {
          throw new Error("ClawRouter reference images must contain PNG, JPEG or WebP data.");
        }
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
          "Unsupported ClawRouter image option; masks, variations and streaming are not supported.",
        );
      }
      const body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        n: requestedCount,
        ...(mode === "edit"
          ? {
              images: inputImages.map((image) => ({
                image_url: "data:" + image.mimeType + ";base64," + image.buffer.toString("base64"),
              })),
            }
          : {}),
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
      if (mode === "edit" && Buffer.byteLength(JSON.stringify(body)) > MAX_EDIT_REQUEST_BYTES) {
        throw new Error("ClawRouter image edit request exceeds the 8 MiB JSON size limit.");
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
      const selected = catalog.find((row) => row.model === req.model && row.modes?.includes(mode));
      if (!selected) {
        throw new Error(
          "ClawRouter image " +
            mode +
            " is not available for this model in this key's current catalog; check the deployment, image grants and budget.",
        );
      }
      assertClawRouterImageLimits(req, selected.limits);
      req.signal?.throwIfAborted();
      const headers = new Headers(context.headers);
      headers.set("Content-Type", "application/json");
      const url =
        context.baseUrl.replace(/\/+$/u, "") +
        (mode === "edit" ? "/images/edits" : "/images/generations");
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
        const count = req.count ?? 1;
        const maxBytes = resolveGeneratedImageDownloadMaxBytes(req.cfg);
        const payload = await readProviderJsonResponse(response, "clawrouter.image-generation", {
          maxBytes: resolveInlineImageJsonResponseMaxBytes(count, maxBytes),
          timeoutMs: remainingTimeoutMs,
        });
        const inline = await inlineOpenAiCompatibleImageUrls(payload, {
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
        const images = parseOpenAiCompatibleImageResponse(inline, {
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
