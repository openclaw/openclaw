import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { ImageGenerationResult } from "openclaw/plugin-sdk/image-generation";
import {
  imageSourceUploadFileName,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedImageDownloadMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  postJsonRequest,
  postMultipartRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildMicrosoftFoundryProvider } from "./provider.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
  DEFAULT_API,
  extractFoundryEndpoint,
  isFoundryMaiImageModel,
  isFoundryProviderApi,
  PROVIDER_ID,
} from "./shared.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IMAGE_SIZE = { width: 1024, height: 1024 };
const MAI_MIN_IMAGE_SIDE_PX = 768;
const MAI_MAX_IMAGE_PIXELS = 1_048_576;
const MAI_IMAGE_BASE_PATH = "/mai/v1";
const MAI_IMAGE_MAX_RESULTS = 1;
const MAI_IMAGE_OUTPUT_MIME = "image/png";
const MAI_IMAGE_UPLOAD_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

function isMaiImageEditModel(modelName: string): boolean {
  const normalized = normalizeOptionalLowercaseString(modelName);
  return normalized === "mai-image-2.5" || normalized === "mai-image-2.5-flash";
}

function resolveMaiImageSize(size: string | undefined): { width: number; height: number } {
  if (!size) {
    return DEFAULT_IMAGE_SIZE;
  }
  const match = size.match(/^(\d{1,5})x(\d{1,5})$/u);
  if (!match) {
    throw new Error(`Microsoft Foundry MAI image size must use WIDTHxHEIGHT, got "${size}".`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    width < MAI_MIN_IMAGE_SIDE_PX ||
    height < MAI_MIN_IMAGE_SIDE_PX ||
    width * height > MAI_MAX_IMAGE_PIXELS
  ) {
    throw new Error(
      `Microsoft Foundry MAI image size must be at least 768x768 and at most 1,048,576 total pixels, got "${size}".`,
    );
  }
  return { width, height };
}

function parseMaiImageResponse(payload: unknown, label: string) {
  const images = parseOpenAiCompatibleImageResponse(payload, {
    defaultMimeType: MAI_IMAGE_OUTPUT_MIME,
    fileNamePrefix: "microsoft-foundry-image",
    malformedResponseError: `${label} response malformed`,
    sniffMimeType: true,
  });
  if (images.length === 0) {
    throw new Error(`${label} response missing image data`);
  }
  return images;
}

export default definePluginEntry({
  id: "microsoft-foundry",
  name: "Microsoft Foundry Provider",
  description: "Microsoft Foundry provider with Entra ID and API key auth",
  register(pluginApi) {
    pluginApi.registerProvider(buildMicrosoftFoundryProvider());
    pluginApi.registerImageGenerationProvider({
      id: PROVIDER_ID,
      label: "Microsoft Foundry",
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      models: [],
      isConfiguredAsync: (ctx) =>
        isProviderApiKeyConfiguredAsync({ provider: PROVIDER_ID, ...ctx }),
      capabilities: {
        generate: {
          maxCount: MAI_IMAGE_MAX_RESULTS,
          supportsSize: true,
        },
        edit: {
          enabled: true,
          maxCount: MAI_IMAGE_MAX_RESULTS,
          maxInputImages: 1,
          supportsSize: false,
        },
        output: {
          formats: ["png"],
        },
      },
      async generateImage(req): Promise<ImageGenerationResult> {
        const providerConfig = req.cfg.models?.providers?.[PROVIDER_ID];
        const model = normalizeOptionalString(req.model);
        if (!model) {
          throw new Error("Microsoft Foundry MAI image generation requires a deployment name.");
        }
        const configuredName = providerConfig?.models?.find(
          (candidate) => candidate.id === model,
        )?.name;
        const modelName = configuredName || model;
        const normalizedModel = normalizeOptionalLowercaseString(model);
        const hasMetadata =
          Boolean(configuredName) &&
          normalizeOptionalLowercaseString(configuredName) !== normalizedModel;
        if (
          !isFoundryMaiImageModel(modelName) &&
          (hasMetadata ||
            (normalizedModel?.startsWith("mai-") && !normalizedModel.startsWith("mai-image-")))
        ) {
          throw new Error(
            `Microsoft Foundry image generation supports MAI image deployments only, got "${modelName}".`,
          );
        }
        const inputImages = req.inputImages ?? [];
        const mode = inputImages.length > 0 ? "edits" : "generations";
        if (req.count !== undefined && req.count !== 1) {
          throw new Error("Microsoft Foundry MAI image models return one image per request.");
        }
        if (inputImages.length > 1) {
          throw new Error("Microsoft Foundry MAI image edits support one input image.");
        }
        if (
          mode === "edits" &&
          (hasMetadata || isFoundryMaiImageModel(model)) &&
          !isMaiImageEditModel(modelName)
        ) {
          throw new Error(`${modelName} does not support Microsoft Foundry MAI image edits.`);
        }
        if (mode === "edits" && !hasMetadata && !isFoundryMaiImageModel(model)) {
          throw new Error(
            "Microsoft Foundry MAI image edits require MAI-Image-2.5 model metadata for custom deployment names.",
          );
        }

        const credentials = await resolveApiKeyForProvider({
          provider: PROVIDER_ID,
          cfg: req.cfg,
          agentDir: req.agentDir,
          store: req.authStore,
        });
        if (!credentials.apiKey) {
          throw new Error("Microsoft Foundry API key missing");
        }
        let auth: { headers: Record<string, string>; baseUrl?: string };
        if (credentials.apiKey !== "__entra_id_dynamic__") {
          auth = { headers: { "api-key": credentials.apiKey } };
        } else {
          const api = isFoundryProviderApi(providerConfig?.api) ? providerConfig.api : DEFAULT_API;
          const prepared = await prepareFoundryRuntimeAuth({
            config: req.cfg,
            agentDir: req.agentDir,
            env: process.env,
            provider: PROVIDER_ID,
            modelId: model,
            model: {
              id: model,
              name: modelName,
              api,
              provider: PROVIDER_ID,
              baseUrl: providerConfig?.baseUrl ?? "",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 0,
            },
            apiKey: credentials.apiKey,
            authMode: credentials.mode,
            ...(credentials.profileId ? { profileId: credentials.profileId } : {}),
          });
          if (!prepared?.apiKey) {
            throw new Error("Microsoft Foundry Entra ID token missing after runtime auth refresh.");
          }
          auth = {
            headers: { Authorization: `Bearer ${prepared.apiKey}` },
            ...(prepared.baseUrl ? { baseUrl: prepared.baseUrl } : {}),
          };
        }
        const endpoint =
          extractFoundryEndpoint(auth.baseUrl) ??
          extractFoundryEndpoint(providerConfig?.baseUrl) ??
          extractFoundryEndpoint(process.env.AZURE_OPENAI_ENDPOINT);
        if (!endpoint) {
          throw new Error("Microsoft Foundry endpoint missing for MAI image generation.");
        }
        const resolvedBaseUrl = `${endpoint}${MAI_IMAGE_BASE_PATH}`;
        const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
          resolveProviderHttpRequestConfig({
            baseUrl: resolvedBaseUrl,
            defaultBaseUrl: resolvedBaseUrl,
            allowPrivateNetwork: false,
            defaultHeaders: auth.headers,
            request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
            provider: PROVIDER_ID,
            capability: "image",
            transport: "http",
          });
        const label =
          mode === "edits"
            ? "Microsoft Foundry MAI image edit"
            : "Microsoft Foundry MAI image generation";
        const deadline = createProviderOperationDeadline({
          timeoutMs: req.timeoutMs,
          label,
        });
        const timeoutMs = resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        });

        const requestOptions = {
          url: `${baseUrl.replace(/\/+$/u, "")}/images/${mode}`,
          headers: new Headers(headers),
          timeoutMs,
          fetchFn: fetch,
          allowPrivateNetwork,
          ssrfPolicy: req.ssrfPolicy,
          dispatcherPolicy,
        };
        let request: ReturnType<typeof postJsonRequest>;
        if (mode === "edits") {
          requestOptions.headers.delete("Content-Type");
          const image = expectDefined(inputImages[0], "Microsoft Foundry edit source image");
          const mimeType =
            normalizeOptionalLowercaseString(image.mimeType) ?? MAI_IMAGE_OUTPUT_MIME;
          if (!MAI_IMAGE_UPLOAD_MIME_TYPES.has(mimeType)) {
            throw new Error("Microsoft Foundry MAI image edits require a PNG or JPEG input image.");
          }
          const form = new FormData();
          form.set("model", model);
          form.set("prompt", req.prompt);
          form.set(
            "image",
            new Blob([bufferToBlobPart(image.buffer)], {
              type: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
            }),
            imageSourceUploadFileName({
              image,
              index: 0,
              fileNamePrefix: "microsoft-foundry-input",
            }),
          );
          request = postMultipartRequest({ ...requestOptions, body: form });
        } else {
          requestOptions.headers.set("Content-Type", "application/json");
          request = postJsonRequest({
            ...requestOptions,
            body: {
              model,
              prompt: req.prompt,
              ...resolveMaiImageSize(req.size),
            },
          });
        }

        const { response, release } = await request;
        try {
          await assertOkOrThrowHttpError(response, `${label} failed`);
          const payload = await readProviderJsonResponse(
            response,
            "microsoft-foundry.image-generation",
            {
              maxBytes: resolveInlineImageJsonResponseMaxBytes(
                MAI_IMAGE_MAX_RESULTS,
                resolveGeneratedImageDownloadMaxBytes(req.cfg),
              ),
            },
          );
          return {
            images: parseMaiImageResponse(payload, label),
            model,
          };
        } finally {
          await release();
        }
      },
    });
  },
});
