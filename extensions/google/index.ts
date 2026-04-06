import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
  normalizeGoogleProviderConfig,
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiTransport,
} from "./api.js";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import { buildGoogleMusicGenerationProvider } from "./music-generation-provider.js";
import { formatGoogleOauthApiKey } from "./oauth-token-shared.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";
import {
  buildGoogleVertexBaseUrl,
  isValidGoogleVertexRegion,
  resolveGoogleVertexProjectId,
  resolveGoogleVertexRegion,
} from "./vertex-region.js";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

let googleImageGenerationProviderPromise: Promise<ImageGenerationProvider> | null = null;
let googleMediaUnderstandingProviderPromise: Promise<MediaUnderstandingProvider> | null = null;

type GoogleMediaUnderstandingProvider = MediaUnderstandingProvider & {
  describeImage: NonNullable<MediaUnderstandingProvider["describeImage"]>;
  describeImages: NonNullable<MediaUnderstandingProvider["describeImages"]>;
  transcribeAudio: NonNullable<MediaUnderstandingProvider["transcribeAudio"]>;
  describeVideo: NonNullable<MediaUnderstandingProvider["describeVideo"]>;
};

const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...buildProviderStreamFamilyHooks("google-thinking"),
};

const GOOGLE_VERTEX_PROVIDER_ID = "google-vertex";
const GOOGLE_VERTEX_DEFAULT_MODEL = `${GOOGLE_VERTEX_PROVIDER_ID}/gemini-3.1-pro-preview`;

async function loadGoogleImageGenerationProvider(): Promise<ImageGenerationProvider> {
  if (!googleImageGenerationProviderPromise) {
    googleImageGenerationProviderPromise = import("./image-generation-provider.js").then((mod) =>
      mod.buildGoogleImageGenerationProvider(),
    );
  }
  return await googleImageGenerationProviderPromise;
}

async function loadGoogleMediaUnderstandingProvider(): Promise<MediaUnderstandingProvider> {
  if (!googleMediaUnderstandingProviderPromise) {
    googleMediaUnderstandingProviderPromise = import("./media-understanding-provider.js").then(
      (mod) => mod.googleMediaUnderstandingProvider,
    );
  }
  return await googleMediaUnderstandingProviderPromise;
}

async function loadGoogleRequiredMediaUnderstandingProvider(): Promise<GoogleMediaUnderstandingProvider> {
  const provider = await loadGoogleMediaUnderstandingProvider();
  if (
    !provider.describeImage ||
    !provider.describeImages ||
    !provider.transcribeAudio ||
    !provider.describeVideo
  ) {
    throw new Error("google media understanding provider missing required handlers");
  }
  return provider as GoogleMediaUnderstandingProvider;
}

function createLazyGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: "gemini-3.1-flash-image-preview",
    models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req),
  };
}

function createLazyGoogleMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "google",
    capabilities: ["image", "audio", "video"],
    defaultModels: {
      image: "gemini-3-flash-preview",
      audio: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    autoPriority: { image: 30, audio: 40, video: 10 },
    nativeDocumentInputs: ["pdf"],
    describeImage: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImage(...args),
    describeImages: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImages(...args),
    transcribeAudio: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).transcribeAudio(...args),
    describeVideo: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeVideo(...args),
  };
}

export default definePluginEntry({
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    registerGoogleGeminiCliProvider(api);
    api.registerProvider({
      id: "google",
      label: "Google AI Studio",
      docsPath: "/providers/models",
      hookAliases: ["google-antigravity"],
      envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "google",
          methodId: "api-key",
          label: "Google Gemini API key",
          hint: "AI Studio / Gemini API key",
          optionKey: "geminiApiKey",
          flagName: "--gemini-api-key",
          envVar: "GEMINI_API_KEY",
          promptMessage: "Enter Gemini API key",
          defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
          expectedProviders: ["google"],
          applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
          wizard: {
            choiceId: "gemini-api-key",
            choiceLabel: "Google Gemini API key",
            groupId: "google",
            groupLabel: "Google",
            groupHint: "Gemini API key + OAuth",
          },
        }),
      ],
      normalizeTransport: ({ api, baseUrl }) =>
        resolveGoogleGenerativeAiTransport({ api, baseUrl }),
      normalizeConfig: ({ provider, providerConfig }) =>
        normalizeGoogleProviderConfig(provider, providerConfig),
      normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
      resolveDynamicModel: (ctx) =>
        resolveGoogleGeminiForwardCompatModel({
          providerId: ctx.provider,
          ctx,
        }),
      ...GOOGLE_GEMINI_PROVIDER_HOOKS,
      isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    });
    api.registerProvider({
      id: GOOGLE_VERTEX_PROVIDER_ID,
      label: "Google Vertex AI",
      docsPath: "/providers/models",
      envVars: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
        "GOOGLE_CLOUD_LOCATION",
        "CLOUD_ML_REGION",
      ],
      auth: [
        {
          id: "oauth",
          label: "Google Vertex AI OAuth",
          hint: "Google OAuth for Vertex AI with project + location",
          kind: "oauth" as const,
          wizard: {
            choiceId: "google-vertex-oauth",
            choiceLabel: "Google Vertex AI (OAuth)",
            choiceHint: "Google OAuth targeting Vertex AI endpoints",
            groupId: "google",
            groupLabel: "Google",
            groupHint: "Gemini API key + OAuth + Vertex AI",
          },
          run: async (ctx: ProviderAuthContext) => {
            const env = ctx.env ?? process.env;
            const location = await ctx.prompter.text({
              message: "Vertex AI location (region)",
              initialValue: resolveGoogleVertexRegion(env),
              placeholder: "us-central1",
            });
            const raw = String(location).trim() || resolveGoogleVertexRegion(env);
            const locationStr = isValidGoogleVertexRegion(raw)
              ? raw
              : resolveGoogleVertexRegion(env);

            const spin = ctx.prompter.progress("Starting Google OAuth for Vertex AI…");
            try {
              const { loginGeminiCliOAuth } = await import("./oauth.runtime.js");
              const result = await loginGeminiCliOAuth({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                log: (msg) => ctx.runtime.log(msg),
                note: ctx.prompter.note,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                progress: spin,
              });

              spin.stop("Google Vertex AI OAuth complete");

              const projectId = result.projectId || resolveGoogleVertexProjectId(env);
              if (!projectId) {
                throw new Error(
                  "Could not determine Google Cloud project ID. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.",
                );
              }

              const baseUrl = buildGoogleVertexBaseUrl({
                region: locationStr,
                projectId,
              });

              const { buildOauthProviderAuthResult } =
                await import("openclaw/plugin-sdk/provider-auth-result");
              return buildOauthProviderAuthResult({
                providerId: GOOGLE_VERTEX_PROVIDER_ID,
                defaultModel: GOOGLE_VERTEX_DEFAULT_MODEL,
                access: result.access,
                refresh: result.refresh,
                expires: result.expires,
                email: result.email,
                ...(result.projectId ? { credentialExtra: { projectId: result.projectId } } : {}),
                configPatch: {
                  models: {
                    providers: {
                      [GOOGLE_VERTEX_PROVIDER_ID]: {
                        baseUrl,
                        api: "google-generative-ai",
                      },
                    },
                  },
                } as never,
                notes: [
                  `Vertex AI endpoint: ${locationStr}`,
                  "If requests fail, verify GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.",
                ],
              });
            } catch (err) {
              spin.stop("Google Vertex AI OAuth failed");
              throw err;
            }
          },
        },
      ],
      catalog: {
        order: "simple" as const,
        run: async (ctx) => {
          const env = ctx.env;
          const existing = ctx.config.models?.providers?.[GOOGLE_VERTEX_PROVIDER_ID];

          // If user already has an explicit baseUrl configured, respect it
          if (existing?.baseUrl) {
            return null;
          }

          const projectId = resolveGoogleVertexProjectId(env);
          if (!projectId) {
            return null;
          }

          const apiKey = ctx.resolveProviderApiKey(GOOGLE_VERTEX_PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }

          const region = resolveGoogleVertexRegion(env);
          const baseUrl = buildGoogleVertexBaseUrl({ region, projectId });

          return {
            provider: {
              baseUrl,
              api: "google-generative-ai",
              apiKey,
              models: existing?.models ?? [],
            },
          };
        },
      },
      normalizeConfig: ({ provider, providerConfig }) =>
        normalizeGoogleProviderConfig(provider, providerConfig),
      normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
      resolveDynamicModel: (ctx) =>
        resolveGoogleGeminiForwardCompatModel({
          providerId: ctx.provider,
          ctx,
        }),
      formatApiKey: (cred) => formatGoogleOauthApiKey(cred),
      ...GOOGLE_GEMINI_PROVIDER_HOOKS,
      isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    });
    api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(createLazyGoogleMediaUnderstandingProvider());
    api.registerMusicGenerationProvider(buildGoogleMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildGoogleVideoGenerationProvider());
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
