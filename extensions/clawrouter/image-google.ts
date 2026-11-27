import {
  buildGoogleImageGenerationBody,
  parseGoogleImageGenerationResponse,
  sniffImageMimeType,
  type ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { postJsonRequest, readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";
import { GOOGLE_IMAGE_CAPABILITIES, qualifiedGoogleImageOffers } from "./image-model-catalog.js";

const JSON_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function validateRequest(req: ImageGenerationRequest) {
  if (
    !req.prompt.trim() ||
    (req.count !== undefined && req.count !== 1) ||
    req.quality !== undefined ||
    req.outputFormat !== undefined ||
    req.background !== undefined ||
    (req.providerOptions && Object.keys(req.providerOptions).length)
  ) {
    throw new Error(
      "ClawRouter Google images require a prompt and one native generation without output overrides",
    );
  }
  const geometry = GOOGLE_IMAGE_CAPABILITIES.geometry!;
  if (
    (req.size && !geometry.sizes!.includes(req.size)) ||
    (req.aspectRatio && !geometry.aspectRatios!.includes(req.aspectRatio)) ||
    (req.resolution && !geometry.resolutions!.includes(req.resolution))
  ) {
    throw new Error("ClawRouter Google image geometry is unsupported");
  }
  if ((req.inputImages?.length ?? 0) > 5) {
    throw new Error("ClawRouter Google images accept at most five inline images");
  }
  if (
    Buffer.byteLength(req.prompt, "utf8") > JSON_LIMIT ||
    (req.inputImages ?? []).reduce((total, image) => total + image.buffer.length, 0) >
      (JSON_LIMIT * 3) / 4
  ) {
    throw new Error("ClawRouter Google image JSON exceeds 8 MiB");
  }
  for (const image of req.inputImages ?? []) {
    if (
      !IMAGE_MIMES.has(image.mimeType) ||
      !image.buffer.length ||
      image.buffer.length > JSON_LIMIT ||
      sniffImageMimeType(image.buffer, "").mimeType !== image.mimeType
    ) {
      throw new Error("ClawRouter Google images require bounded PNG, JPEG or WebP inline inputs");
    }
  }
}

function readQualifiedImages(payload: unknown) {
  const body = asOptionalRecord(payload);
  if (
    !body ||
    body.error !== undefined ||
    !Array.isArray(body.candidates) ||
    !body.candidates.length
  ) {
    throw new Error("ClawRouter Google image response is incomplete");
  }
  for (const value of body.candidates) {
    const candidate = asOptionalRecord(value);
    const content = asOptionalRecord(candidate?.content);
    if (candidate?.finishReason !== "STOP" || !Array.isArray(content?.parts)) {
      throw new Error("ClawRouter Google image response is incomplete");
    }
    for (const partValue of content.parts) {
      const part = asOptionalRecord(partValue);
      const inline = asOptionalRecord(part?.inlineData ?? part?.inline_data);
      if (
        !part ||
        ((part.inlineData !== undefined || part.inline_data !== undefined) && !inline) ||
        part.fileData !== undefined ||
        part.file_data !== undefined ||
        (part.inlineData !== undefined && part.inline_data !== undefined) ||
        (inline &&
          (part.thought === true ||
            !IMAGE_MIMES.has(String(inline.mimeType ?? inline.mime_type)) ||
            (inline.mimeType !== undefined && inline.mime_type !== undefined)))
      ) {
        throw new Error("ClawRouter Google image response has an unqualified asset");
      }
    }
  }
  const images = parseGoogleImageGenerationResponse(payload);
  if (
    images.length > 4 ||
    images.reduce((total, image) => total + image.buffer.length, 0) > OUTPUT_LIMIT ||
    images.some(
      (image) =>
        !IMAGE_MIMES.has(image.mimeType) ||
        sniffImageMimeType(image.buffer, "").mimeType !== image.mimeType,
    )
  ) {
    throw new Error("ClawRouter Google image response exceeds its qualified output bounds");
  }
  return images;
}

export async function generateClawRouterGoogleImage(
  req: ImageGenerationRequest,
  remaining: () => number,
) {
  validateRequest(req);
  const configured = req.cfg.models?.providers?.clawrouter;
  if (configured?.request?.auth && configured.request.auth.mode !== "provider-default") {
    throw new Error("ClawRouter Google images require provider-default authentication");
  }
  for (const name of [
    ...Object.keys(configured?.headers ?? {}),
    ...Object.keys(configured?.request?.headers ?? {}),
  ]) {
    if (
      [
        "authorization",
        "x-goog-api-key",
        "x-api-key",
        "api-key",
        "cookie",
        "content-type",
        "content-length",
      ].includes(name.toLowerCase())
    ) {
      throw new Error("ClawRouter Google images reject credential or payload header overrides");
    }
  }
  const body = buildGoogleImageGenerationBody(req);
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > JSON_LIMIT) {
    throw new Error("ClawRouter Google image JSON exceeds 8 MiB");
  }
  req.signal?.throwIfAborted();
  const auth = await resolveApiKeyForProvider({
    provider: "clawrouter",
    cfg: req.cfg,
    agentDir: req.agentDir,
    store: req.authStore,
    modelId: req.model,
    capability: "image",
    signal: req.signal,
  });
  if (!auth.apiKey || auth.mode !== "api-key") {
    throw new Error("ClawRouter key missing; native Google credentials are not used");
  }
  const context = resolveClawRouterCapabilityHttpContext(req.cfg, auth.apiKey, "image");
  const offers = await fetchClawRouterCapabilityOffers({
    context,
    timeoutMs: remaining,
    signal: req.signal,
    ssrfPolicy: req.ssrfPolicy,
    requireFreshProxyCatalog: true,
  });
  const offer = qualifiedGoogleImageOffers(offers).find(
    (candidate) => candidate.model?.id === req.model,
  );
  if (!offer) {
    throw new Error("ClawRouter Google image model has no qualified current catalog offer");
  }
  const envelope =
    offer.routeKind === "manifest" ? { body, pathParams: { model: offer.model!.upstream } } : body;
  const headers = new Headers(context.headers);
  headers.set("content-type", "application/json");
  const { response, release } = await postJsonRequest({
    url: offer.url,
    headers,
    body: envelope,
    timeoutMs: remaining(),
    signal: req.signal,
    fetchFn: (input, init) => fetchWithRuntimeDispatcher(input, { ...init, redirect: "error" }),
    allowPrivateNetwork: context.allowPrivateNetwork,
    ssrfPolicy: mergeSsrFPolicies(req.ssrfPolicy, context.ssrfPolicy),
    dispatcherPolicy: context.dispatcherPolicy,
  });
  try {
    if (response.status !== 200) {
      throw new Error(`ClawRouter Google image generation failed (HTTP ${response.status})`);
    }
    const payload = await readProviderJsonResponse(response, "clawrouter.google-image", {
      maxBytes: JSON_LIMIT,
      timeoutMs: remaining,
    });
    const images = readQualifiedImages(payload);
    req.signal?.throwIfAborted();
    return { images, model: req.model };
  } finally {
    void response.body?.cancel().catch(() => undefined);
    await release();
  }
}
