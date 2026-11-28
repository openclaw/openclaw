import {
  buildGoogleImageGenerationBody,
  parseGoogleImageGenerationResponse,
  resolveInlineImageJsonResponseMaxBytes,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedImageDownloadMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import {
  postJsonResponse,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { toStandardGoogleProviderBase64 } from "./base64.js";
import { resolveGoogleGenerationApiKey } from "./generation-auth.js";
import {
  createGoogleImageGenerationProviderMetadata,
  DEFAULT_GOOGLE_IMAGE_MODEL,
  GOOGLE_MAX_IMAGE_RESULTS,
} from "./generation-provider-metadata.js";
import { resolveGoogleGenerativeAiHttpRequestConfig } from "./http-request.js";
import { normalizeGoogleModelId } from "./model-id.js";

const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;

export const googleImageGenerationProvider: ImageGenerationProvider = {
  ...createGoogleImageGenerationProviderMetadata(),
  isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "google", ...ctx }),
  async generateImage(req) {
    const apiKey = await resolveGoogleGenerationApiKey(req);

    const model = normalizeGoogleModelId(req.model?.trim() || DEFAULT_GOOGLE_IMAGE_MODEL);
    const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
      resolveGoogleGenerativeAiHttpRequestConfig({
        apiKey,
        baseUrl: req.cfg?.models?.providers?.google?.baseUrl,
        request: sanitizeConfiguredModelProviderRequest(
          req.cfg?.models?.providers?.google?.request,
        ),
        capability: "image",
        transport: "http",
      });
    const payload = await postJsonResponse<unknown>({
      url: `${baseUrl}/models/${model}:generateContent`,
      headers,
      body: buildGoogleImageGenerationBody(req),
      timeoutMs: req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
      fetchFn: fetch,
      pinDns: false,
      allowPrivateNetwork,
      ssrfPolicy: req.ssrfPolicy,
      dispatcherPolicy,
      errorLabel: "Google image generation failed",
      responseLabel: "google.image-generation",
      readOptions: {
        maxBytes: resolveInlineImageJsonResponseMaxBytes(
          GOOGLE_MAX_IMAGE_RESULTS,
          resolveGeneratedImageDownloadMaxBytes(req.cfg),
        ),
      },
    });
    const images = parseGoogleImageGenerationResponse(payload, toStandardGoogleProviderBase64);

    return {
      images,
      model,
    };
  },
};
