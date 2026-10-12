import path from "node:path";
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationProviderConfiguredContext,
  ImageGenerationResult,
} from "openclaw/plugin-sdk/image-generation";
import type { resolveClosestSize } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import type { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-policy";
import { filterStringRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  canonicalizeCodexResponsesBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import {
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL,
} from "./default-models.js";
import { resolveModelAuthPolicy } from "./provider-policy-api.js";
import { resolveConfiguredOpenAIBaseUrl } from "./shared.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;
const OPENAI_MODEL_REF_PREFIX = "openai/";
const DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL = OPENAI_CODEX_DEFAULT_MODEL.slice(
  OPENAI_MODEL_REF_PREFIX.length,
);
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-1.5";
const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;
const OPENAI_MAX_IMAGE_RESULTS = 4;
const LOG_VALUE_MAX_CHARS = 256;
const MOCK_OPENAI_PROVIDER_ID = "mock-openai";
const OPENAI_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const OPENAI_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const OPENAI_QUALITIES = ["low", "medium", "high", "auto"] as const;
const OPENAI_IMAGE_25_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
const OPENAI_IMAGE_25_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const OPENAI_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_IMAGE_25_MODELS,
  OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const OPENAI_FLEXIBLE_IMAGE_MODELS = [
  DEFAULT_OPENAI_IMAGE_MODEL,
  ...OPENAI_IMAGE_25_MODELS,
  "gpt-image-2-2026-04-21",
] as const;

const AZURE_HOSTNAME_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
] as const;

const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";

function sanitizeLogValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const cleaned = raw
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gi, "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "unknown";
  }
  return cleaned.length > LOG_VALUE_MAX_CHARS
    ? `${truncateUtf16Safe(cleaned, LOG_VALUE_MAX_CHARS)}...`
    : cleaned;
}

function resolveOpenAIImageTimeoutMs(
  timeoutMs: number | undefined,
  options?: { isAzure?: boolean },
): number {
  return (
    timeoutMs ??
    (options?.isAzure ? DEFAULT_AZURE_OPENAI_IMAGE_TIMEOUT_MS : DEFAULT_OPENAI_IMAGE_TIMEOUT_MS)
  );
}

function isPublicOpenAIImageBaseUrl(baseUrl: string): boolean {
  const parsed = URL.parse(baseUrl.trim());
  if (!parsed) {
    return false;
  }
  const pathName = parsed.pathname.replace(/\/+$/, "");
  return (
    parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === "api.openai.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    pathName === "/v1"
  );
}

function isAzureOpenAIBaseUrl(baseUrl?: string): boolean {
  const hostname = URL.parse(baseUrl?.trim() ?? "")?.hostname.toLowerCase();
  return (
    hostname !== undefined && AZURE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

function resolveAzureApiVersion(): string {
  return process.env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function buildAzureImageUrl(
  rawBaseUrl: string,
  model: string,
  action: "generations" | "edits",
): string {
  const cleanBase = rawBaseUrl
    .replace(/\/+$/, "")
    .replace(/\/openai\/v1$/, "")
    .replace(/\/v1$/, "");
  return `${cleanBase}/openai/deployments/${model}/images/${action}?api-version=${resolveAzureApiVersion()}`;
}

function resolveOutputMime(outputFormat?: ImageGenerationOutputFormat): {
  mimeType: string;
  extension: string;
} {
  switch (outputFormat) {
    case "jpeg":
      return { mimeType: "image/jpeg", extension: "jpg" };
    case "webp":
      return { mimeType: "image/webp", extension: "webp" };
    default:
      return { mimeType: DEFAULT_OUTPUT_MIME, extension: "png" };
  }
}

type OpenAIImageRequest = Parameters<ImageGenerationProvider["generateImage"]>[0];

function resolveOpenAIImageOptions(req: OpenAIImageRequest): Record<string, unknown> {
  const openai = req.providerOptions?.openai;
  const background = openai?.background ?? req.background;
  const outputCompression =
    req.outputFormat === "jpeg" || req.outputFormat === "webp"
      ? openai?.outputCompression
      : undefined;
  return {
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    ...(req.outputFormat !== undefined ? { output_format: req.outputFormat } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(openai?.moderation !== undefined ? { moderation: openai.moderation } : {}),
    ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
  };
}

function resolveOpenAIImageRequestModel(
  req: Parameters<ImageGenerationProvider["generateImage"]>[0],
  options?: { allowTransparentDefaultReroute?: boolean },
): string {
  const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
  if (
    options?.allowTransparentDefaultReroute === true &&
    model === DEFAULT_OPENAI_IMAGE_MODEL &&
    (req.providerOptions?.openai?.background ?? req.background) === "transparent"
  ) {
    return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
  }
  return model;
}

function resolveNativeOpenAIImageSizesForModel(model: string): readonly string[] {
  switch (model) {
    case "gpt-image-1":
    case "gpt-image-1-mini":
      return OPENAI_LEGACY_IMAGE_SIZES;
    default:
      return OPENAI_SUPPORTED_SIZES;
  }
}

function isValidFlexibleOpenAIImageSize(model: string, size: string | undefined): size is string {
  if (!OPENAI_FLEXIBLE_IMAGE_MODELS.some((candidate) => candidate === model)) {
    return false;
  }
  if (size === "auto") {
    return OPENAI_IMAGE_25_MODELS.some((candidate) => candidate === model);
  }
  const dimensions = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!dimensions) {
    return false;
  }
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  const pixels = width * height;
  return (
    width > 0 &&
    height > 0 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    Math.max(width, height) <= 3840 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400 &&
    width <= height * 3 &&
    height <= width * 3
  );
}

function resolveConfiguredOpenAIImageBaseUrl(cfg: OpenClawConfig | undefined, model: string) {
  const modelId = model.trim().replace(/^openai\//u, "");
  const modelBaseUrl = cfg?.models?.providers?.openai?.models
    ?.find((candidate) => candidate.id.trim().replace(/^openai\//u, "") === modelId)
    ?.baseUrl?.trim();
  return modelBaseUrl || resolveConfiguredOpenAIBaseUrl(cfg);
}

function resolveOpenAIImageRequestSize(
  params: {
    model: string;
    requestedSize?: string;
    applyNativeLimits: boolean;
  },
  resolveSize: typeof resolveClosestSize,
): {
  size: string;
  metadata?: Record<string, string>;
} {
  const requestedSize = params.requestedSize ?? DEFAULT_SIZE;
  if (!params.applyNativeLimits) {
    return { size: requestedSize };
  }
  const supportedSizes = resolveNativeOpenAIImageSizesForModel(params.model);
  const size =
    resolveSize({
      requestedSize,
      supportedSizes,
    }) ?? DEFAULT_SIZE;
  if (size === requestedSize) {
    return { size };
  }
  return {
    size,
    metadata: {
      requestedSize,
      normalizedSize: size,
    },
  };
}

function shouldAllowPrivateImageEndpoint(req: {
  provider: string;
  model: string;
  cfg: OpenClawConfig | undefined;
}) {
  if (req.provider === MOCK_OPENAI_PROVIDER_ID) {
    return true;
  }
  if (isPrivateNetworkOptInEnabled(req.cfg?.browser?.ssrfPolicy)) {
    return true;
  }
  const baseUrl = resolveConfiguredOpenAIImageBaseUrl(req.cfg, req.model);
  if (!baseUrl.startsWith("http://127.0.0.1:") && !baseUrl.startsWith("http://localhost:")) {
    return false;
  }
  return process.env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER === "1";
}

type OpenAIImageModelAuth = Pick<
  OpenClawPluginApi["runtime"]["modelAuth"],
  | "ensureAuthProfileStore"
  | "ensureAuthProfileStoreAsync"
  | "listProfilesForProvider"
  | "isProviderApiKeyConfigured"
  | "isProviderApiKeyConfiguredAsync"
>;

async function resolveRequestAuthStore(
  req: { authStore?: AuthProfileStore; agentDir?: string },
  modelAuth: OpenAIImageModelAuth,
): Promise<AuthProfileStore | undefined> {
  if (req.authStore) {
    return req.authStore;
  }
  const agentDir = req.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  return modelAuth.ensureAuthProfileStoreAsync(agentDir, {
    allowKeychainPrompt: false,
  });
}

function hasOpenAIImageApiKeyProfile(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  const profileIds = modelAuth.listProfilesForProvider(store, "openai");
  if (profileIds.length === 0) {
    return false;
  }
  return profileIds.some((profileId) => store.profiles[profileId]?.type === "api_key");
}

function hasCodexResponseTransportProfileConfigured(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  return modelAuth.listProfilesForProvider(store, "openai").some((profileId) => {
    const credential = store.profiles[profileId];
    return (
      (credential?.type === "oauth" || credential?.type === "token") &&
      resolveModelAuthPolicy({
        provider: "openai",
        mode: credential.type,
        authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
        capability: "image-generation",
      })?.compatible === true
    );
  });
}

function hasExplicitOpenAIImageApiKeyConfig(cfg: OpenClawConfig | undefined): boolean {
  const providerConfig = cfg?.models?.providers?.openai;
  return providerConfig?.apiKey !== undefined || providerConfig?.auth === "api-key";
}

function hasDirectOpenAIImageRoute(cfg: OpenClawConfig | undefined): boolean {
  return (
    isPublicOpenAIImageBaseUrl(resolveConfiguredOpenAIBaseUrl(cfg)) ||
    hasExplicitOpenAIImageApiKeyConfig(cfg) ||
    Boolean(process.env.OPENAI_API_KEY?.trim())
  );
}

function hasOpenAIImageProfileRoute(
  cfg: OpenClawConfig | undefined,
  authStore: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  return (
    hasOpenAIImageApiKeyProfile(authStore, modelAuth) ||
    (hasChatGPTImageRouteConfig(cfg) &&
      hasCodexResponseTransportProfileConfigured(authStore, modelAuth))
  );
}

function hasExplicitDirectOpenAIImageConfig(cfg: OpenClawConfig | undefined): boolean {
  const providerConfig = cfg?.models?.providers?.openai;
  if (!providerConfig) {
    return false;
  }
  return (
    hasExplicitOpenAIImageApiKeyConfig(cfg) ||
    providerConfig.headers !== undefined ||
    providerConfig.authHeader !== undefined ||
    providerConfig.request !== undefined ||
    (providerConfig.api !== undefined && providerConfig.api !== "openai-chatgpt-responses")
  );
}

function hasChatGPTImageRouteConfig(cfg: OpenClawConfig | undefined): boolean {
  const providerConfig = cfg?.models?.providers?.openai;
  return (
    isOpenAICodexBaseUrl(resolveConfiguredOpenAIBaseUrl(cfg)) ||
    providerConfig?.api === "openai-chatgpt-responses"
  );
}

function forceOpenAIImageApiKeyAuth(cfg: OpenClawConfig | undefined): OpenClawConfig | undefined {
  if (!hasExplicitOpenAIImageApiKeyConfig(cfg)) {
    return cfg;
  }
  const providerConfig = cfg?.models?.providers?.openai;
  if (!providerConfig) {
    return cfg;
  }
  return {
    ...cfg,
    models: {
      ...cfg?.models,
      providers: {
        ...cfg?.models?.providers,
        openai: {
          ...providerConfig,
          auth: "api-key",
        },
      },
    },
  };
}

function isCodexSubscriptionAuthMode(mode: unknown): boolean {
  return mode === "oauth" || mode === "token";
}

function inferImageUploadFileName(params: {
  fileName?: string;
  mimeType?: string;
  index: number;
}): string {
  const fileName = params.fileName?.trim();
  if (fileName) {
    return path.basename(fileName);
  }
  const mimeType = params.mimeType?.trim().toLowerCase() || DEFAULT_OUTPUT_MIME;
  const ext = extensionForMime(mimeType)?.slice(1) ?? "png";
  return `image-${params.index + 1}.${ext}`;
}

async function resolveOptionalImageAuth(req: OpenAIImageRequest, apiKeyOnly = false) {
  const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
  try {
    return await resolveApiKeyForProvider({
      provider: "openai",
      capability: "image-generation",
      cfg: apiKeyOnly ? forceOpenAIImageApiKeyAuth(req.cfg) : req.cfg,
      agentDir: req.agentDir,
      store: req.authStore,
      ...(apiKeyOnly ? { credentialPrecedence: "env-first" } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.startsWith('No API key found for provider "openai".')) {
      throw error;
    }
    return null;
  }
}

// ChatGPT plans do not all offer the Codex default model. The default stays first so
// working installs keep their route; configured OpenAI models are the recovery order
// when the account rejects the model that hosts the image_generation tool.
function resolveCodexImageResponsesModels(cfg: OpenClawConfig | undefined): [string, ...string[]] {
  const agentModel = cfg?.agents?.defaults?.model;
  const retryModels = new Set<string>();
  for (const ref of [
    resolveAgentModelPrimaryValue(agentModel),
    ...resolveAgentModelFallbackValues(agentModel),
  ]) {
    const modelRef = ref?.trim();
    const modelId = modelRef?.startsWith(OPENAI_MODEL_REF_PREFIX)
      ? modelRef.slice(OPENAI_MODEL_REF_PREFIX.length)
      : undefined;
    if (modelId && modelId !== DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL) {
      retryModels.add(modelId);
    }
  }
  return [DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL, ...retryModels];
}

function isCodexModelUnavailableBody(body: string | undefined, model: string): boolean {
  if (!body) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(body);
    return (
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload &&
      payload.detail ===
        `The '${model}' model is not supported when using Codex with a ChatGPT account.`
    );
  } catch {
    return false;
  }
}

async function generateOpenAICodexImage(params: {
  req: OpenAIImageRequest;
  apiKey: string;
  authMode?: unknown;
}): Promise<ImageGenerationResult> {
  const { req, apiKey } = params;
  const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs);
  const { createSubsystemLogger: createLogger } = await import("openclaw/plugin-sdk/logging-core");
  const model = resolveOpenAIImageRequestModel(req, {
    allowTransparentDefaultReroute: true,
  });
  createLogger("image-generation/openai").info(
    `image auth selected: provider=openai mode=${sanitizeLogValue(
      params.authMode,
    )} transport=codex-responses requestedModel=${sanitizeLogValue(
      model,
    )} responsesModel=${DEFAULT_OPENAI_CODEX_IMAGE_RESPONSES_MODEL} timeoutMs=${timeoutMs}`,
  );
  const [
    {
      ProviderHttpError,
      assertOkOrThrowHttpError,
      postJsonRequest,
      resolveProviderHttpRequestConfig,
      sanitizeConfiguredModelProviderRequest,
    },
    { toImageDataUrl },
    { resolveClosestSize },
    { readCodexImageGenerationResponse },
  ] = await Promise.all([
    import("openclaw/plugin-sdk/provider-http"),
    import("openclaw/plugin-sdk/image-generation"),
    import("openclaw/plugin-sdk/media-generation-runtime"),
    import("./image-generation-codex-response.js"),
  ]);
  const inputImages = req.inputImages ?? [];
  const openAIProviderConfig = req.cfg?.models?.providers?.openai;
  const codexProviderConfig =
    openAIProviderConfig?.api === "openai-chatgpt-responses" ? openAIProviderConfig : undefined;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: canonicalizeCodexResponsesBaseUrl(codexProviderConfig?.baseUrl),
      defaultBaseUrl: DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL,
      defaultHeaders: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      request: sanitizeConfiguredModelProviderRequest(codexProviderConfig?.request),
      provider: "openai",
      api: "openai-chatgpt-responses",
      capability: "image",
      transport: "http",
    });

  const count = resolveIntegerOption(req.count, 1, { min: 1, max: OPENAI_MAX_IMAGE_RESULTS });
  const sizeResolution = resolveOpenAIImageRequestSize(
    {
      model,
      requestedSize: req.size,
      applyNativeLimits: true,
    },
    resolveClosestSize,
  );
  const size = sizeResolution.size;
  headers.set("Content-Type", "application/json");
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: req.prompt },
    ...inputImages.map((image) => ({
      type: "input_image",
      image_url: toImageDataUrl({ buffer: image.buffer, mimeType: image.mimeType }),
      detail: "auto",
    })),
  ];
  const requestImage = async (responsesModel: string): Promise<ImageGenerationResult> => {
    const requestResult = await postJsonRequest({
      url: `${baseUrl}/responses`,
      headers,
      body: {
        model: responsesModel,
        input: [
          {
            role: "user",
            content,
          },
        ],
        instructions: OPENAI_CODEX_IMAGE_INSTRUCTIONS,
        tools: [
          {
            type: "image_generation",
            model,
            size,
            ...resolveOpenAIImageOptions(req),
          },
        ],
        tool_choice: { type: "image_generation" },
        stream: true,
        store: false,
      },
      timeoutMs,
      fetchFn: fetch,
      allowPrivateNetwork,
      ssrfPolicy: req.ssrfPolicy,
      dispatcherPolicy,
    });
    const { response, release } = requestResult;
    try {
      await assertOkOrThrowHttpError(response, "OpenAI Codex image generation failed");
      return await readCodexImageGenerationResponse(response, {
        model,
        ...resolveOutputMime(req.outputFormat),
      });
    } finally {
      await release();
    }
  };
  const [defaultResponsesModel, ...retryResponsesModels] = resolveCodexImageResponsesModels(
    req.cfg,
  );
  let responsesModel = defaultResponsesModel;
  const results: ImageGenerationResult[] = [];
  for (let index = 0; index < count; index += 1) {
    for (;;) {
      try {
        results.push(await requestImage(responsesModel));
        break;
      } catch (error) {
        const nextResponsesModel = retryResponsesModels.shift();
        if (
          !nextResponsesModel ||
          !(error instanceof ProviderHttpError) ||
          error.status !== 400 ||
          !isCodexModelUnavailableBody(error.errorBody, responsesModel)
        ) {
          throw error;
        }
        const { createSubsystemLogger } = await import("openclaw/plugin-sdk/logging-core");
        createSubsystemLogger("image-generation/openai").info(
          `codex image responses model unavailable: responsesModel=${sanitizeLogValue(
            responsesModel,
          )} retryResponsesModel=${sanitizeLogValue(nextResponsesModel)}`,
        );
        responsesModel = nextResponsesModel;
      }
    }
  }
  const images = results.flatMap((result) => result.images);
  const output = resolveOutputMime(req.outputFormat);
  return {
    images: images.map((image, index) =>
      Object.assign({}, image, {
        fileName: `image-${index + 1}.${output.extension}`,
      }),
    ),
    model,
    metadata: {
      ...sizeResolution.metadata,
      responses: results.map((result) => result.metadata).filter(Boolean),
    },
  };
}

export function buildOpenAIImageGenerationProvider(
  modelAuth: OpenAIImageModelAuth,
): ImageGenerationProvider {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    models: [...OPENAI_IMAGE_MODELS],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: OPENAI_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
        // Empty model-specific lists stop core from snapping valid flexible dimensions.
        sizesByModel: Object.fromEntries(OPENAI_FLEXIBLE_IMAGE_MODELS.map((model) => [model, []])),
      },
      output: {
        formats: [...OPENAI_OUTPUT_FORMATS],
        qualities: [...OPENAI_QUALITIES],
        qualitiesByModel: Object.fromEntries(
          OPENAI_IMAGE_25_MODELS.map((model) => [model, [...OPENAI_IMAGE_25_QUALITIES]]),
        ),
        backgrounds: [...OPENAI_BACKGROUNDS],
      },
    },
    // Released synchronous discovery must retain the image-specific auth policy.
    isConfigured({ cfg, agentDir }: ImageGenerationProviderConfiguredContext) {
      const directRoute = hasDirectOpenAIImageRoute(cfg);
      const authStore =
        directRoute || !agentDir?.trim()
          ? undefined
          : modelAuth.ensureAuthProfileStore(agentDir.trim(), { allowKeychainPrompt: false });
      return (
        modelAuth.isProviderApiKeyConfigured({
          provider: "openai",
          agentDir,
          cfg,
          store: authStore,
          capability: "image-generation",
        }) &&
        (directRoute || hasOpenAIImageProfileRoute(cfg, authStore, modelAuth))
      );
    },
    async isConfiguredAsync({ cfg, agentDir }) {
      const directRoute = hasDirectOpenAIImageRoute(cfg);
      const authStore = directRoute
        ? undefined
        : await resolveRequestAuthStore({ agentDir }, modelAuth);
      const configured = await modelAuth.isProviderApiKeyConfiguredAsync({
        provider: "openai",
        agentDir,
        cfg,
        store: authStore,
        capability: "image-generation",
      });
      return configured && (directRoute || hasOpenAIImageProfileRoute(cfg, authStore, modelAuth));
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const rawBaseUrl = resolveConfiguredOpenAIImageBaseUrl(req.cfg, req.model);
      const publicOpenAIBaseUrl = isPublicOpenAIImageBaseUrl(rawBaseUrl);
      const chatGPTBaseUrl = isOpenAICodexBaseUrl(rawBaseUrl);
      const codexResponsesConfigured =
        req.cfg?.models?.providers?.openai?.api === "openai-chatgpt-responses";
      const explicitOpenAIApiKeyConfig = hasExplicitOpenAIImageApiKeyConfig(req.cfg);
      const explicitDirectOpenAIConfig =
        !chatGPTBaseUrl && !codexResponsesConfigured && hasExplicitDirectOpenAIImageConfig(req.cfg);
      const useCodexResponseTransportRoute =
        (publicOpenAIBaseUrl || chatGPTBaseUrl || codexResponsesConfigured) &&
        !explicitDirectOpenAIConfig &&
        hasCodexResponseTransportProfileConfigured(
          await resolveRequestAuthStore(req, modelAuth),
          modelAuth,
        );
      let imageAuth:
        | NonNullable<Awaited<ReturnType<typeof resolveApiKeyForProvider>>>
        | null
        | undefined;
      if (explicitOpenAIApiKeyConfig) {
        const directAuth = await resolveOptionalImageAuth(req, true);
        imageAuth =
          directAuth?.apiKey && (directAuth.mode === undefined || directAuth.mode === "api-key")
            ? directAuth
            : null;
      }
      if (useCodexResponseTransportRoute) {
        const codexAuth = await resolveOptionalImageAuth(req);
        if (!codexAuth?.apiKey) {
          throw new Error("OpenAI Codex OAuth missing");
        }
        if (codexAuth.mode === "api-key") {
          imageAuth = codexAuth;
        } else {
          return generateOpenAICodexImage({
            req,
            apiKey: codexAuth.apiKey,
            authMode: codexAuth.mode,
          });
        }
      }

      if (imageAuth === undefined) {
        imageAuth = await resolveOptionalImageAuth(req);
      }
      if (
        !explicitDirectOpenAIConfig &&
        imageAuth?.apiKey &&
        isCodexSubscriptionAuthMode(imageAuth.mode)
      ) {
        if (publicOpenAIBaseUrl) {
          return generateOpenAICodexImage({
            req,
            apiKey: imageAuth.apiKey,
            authMode: imageAuth.mode,
          });
        }
        imageAuth = undefined;
      }
      if (!imageAuth?.apiKey) {
        if (!publicOpenAIBaseUrl) {
          throw new Error("OpenAI API key missing");
        }
        throw new Error("OpenAI API key or Codex OAuth missing");
      }
      const [
        {
          assertOkOrThrowHttpError,
          postJsonRequest,
          postMultipartRequest,
          readProviderJsonResponse,
          resolveProviderHttpRequestConfig,
          sanitizeConfiguredModelProviderRequest,
        },
        { parseOpenAiCompatibleImageResponse, resolveInlineImageJsonResponseMaxBytes },
        { resolveClosestSize, resolveGeneratedMediaMaxBytes },
      ] = await Promise.all([
        import("openclaw/plugin-sdk/provider-http"),
        import("openclaw/plugin-sdk/image-generation"),
        import("openclaw/plugin-sdk/media-generation-runtime"),
      ]);
      const isAzure = isAzureOpenAIBaseUrl(rawBaseUrl);
      const openAIProviderConfig = req.cfg?.models?.providers?.openai;

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: rawBaseUrl,
          defaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
          allowPrivateNetwork: shouldAllowPrivateImageEndpoint(req),
          headers: filterStringRecord(openAIProviderConfig?.headers),
          request: sanitizeConfiguredModelProviderRequest(openAIProviderConfig?.request),
          api: openAIProviderConfig?.api,
          defaultHeaders: isAzure
            ? { "api-key": imageAuth.apiKey }
            : { Authorization: `Bearer ${imageAuth.apiKey}` },
          provider: "openai",
          capability: "image",
          transport: "http",
        });

      const model = resolveOpenAIImageRequestModel(req, {
        allowTransparentDefaultReroute: publicOpenAIBaseUrl,
      });
      const count = resolveIntegerOption(req.count, 1, { min: 1, max: OPENAI_MAX_IMAGE_RESULTS });
      const timeoutMs = resolveOpenAIImageTimeoutMs(req.timeoutMs, { isAzure });
      const sizeResolution = isValidFlexibleOpenAIImageSize(model, req.size)
        ? { size: req.size }
        : resolveOpenAIImageRequestSize(
            {
              model,
              requestedSize: req.size,
              applyNativeLimits: publicOpenAIBaseUrl || isAzure,
            },
            resolveClosestSize,
          );
      const size = sizeResolution.size;
      const url = isAzure
        ? buildAzureImageUrl(rawBaseUrl, model, isEdit ? "edits" : "generations")
        : `${baseUrl}/images/${isEdit ? "edits" : "generations"}`;
      const body: Record<string, unknown> = {
        ...(!isAzure ? { model } : {}),
        prompt: req.prompt,
        n: count,
        size,
        ...resolveOpenAIImageOptions(req),
        ...(req.providerOptions?.openai?.user !== undefined
          ? { user: req.providerOptions.openai.user }
          : {}),
      };
      const requestOptions = {
        url,
        headers: new Headers(headers),
        timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      };
      const form = isEdit ? new FormData() : undefined;
      if (form) {
        for (const [key, value] of Object.entries(body)) {
          form.set(key, String(value));
        }
        for (const [index, image] of inputImages.entries()) {
          const mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
          form.append(
            "image[]",
            new Blob([bufferToBlobPart(image.buffer)], { type: mimeType }),
            inferImageUploadFileName({ fileName: image.fileName, mimeType, index }),
          );
        }
        requestOptions.headers.delete("Content-Type");
      } else {
        requestOptions.headers.set("Content-Type", "application/json");
      }
      const requestResult = form
        ? await postMultipartRequest({ ...requestOptions, body: form })
        : await postJsonRequest({ ...requestOptions, body });
      const { response, release } = requestResult;
      try {
        const operation = isEdit ? "OpenAI image edit" : "OpenAI image generation";
        await assertOkOrThrowHttpError(response, `${operation} failed`);

        const data = await readProviderJsonResponse(response, "openai.image-generation", {
          maxBytes: resolveInlineImageJsonResponseMaxBytes(
            count,
            resolveGeneratedMediaMaxBytes(req.cfg, "image"),
          ),
        });
        const output = resolveOutputMime(req.outputFormat);
        const images = parseOpenAiCompatibleImageResponse(data, {
          defaultMimeType: output.mimeType,
          malformedResponseError: `${operation} response malformed`,
        }).map((image, index) =>
          Object.assign(image, {
            fileName: `image-${index + 1}.${output.extension}`,
          }),
        );
        if (images.length === 0) {
          throw new Error(`${operation} response missing image data`);
        }

        return {
          images,
          model,
          ...(sizeResolution.metadata ? { metadata: sizeResolution.metadata } : {}),
        };
      } finally {
        await release();
      }
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
