import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderFetchUsageSnapshotContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
  createGoogleThinkingPayloadWrapper,
} from "openclaw/plugin-sdk/provider-google";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { isModernGoogleModel, resolveGoogle31ForwardCompatModel } from "./provider-models.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_GEMINI_CLI_PROVIDER_LABEL = "Gemini CLI OAuth";
const GOOGLE_GEMINI_CLI_DEFAULT_MODEL = "google-gemini-cli/gemini-3.1-pro-preview";
const GOOGLE_GEMINI_CLI_ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
] as const;

type GoogleOauthApiKeyCredential = {
  type?: string;
  access?: string;
  projectId?: string;
};

let googleGeminiCliProviderPromise: Promise<ProviderPlugin> | null = null;
let googleImageGenerationProviderPromise: Promise<ImageGenerationProvider> | null = null;
let googleMediaUnderstandingProviderPromise: Promise<MediaUnderstandingProvider> | null = null;

type GoogleMediaUnderstandingProvider = MediaUnderstandingProvider & {
  describeImage: NonNullable<MediaUnderstandingProvider["describeImage"]>;
  describeImages: NonNullable<MediaUnderstandingProvider["describeImages"]>;
  transcribeAudio: NonNullable<MediaUnderstandingProvider["transcribeAudio"]>;
  describeVideo: NonNullable<MediaUnderstandingProvider["describeVideo"]>;
};

function formatGoogleOauthApiKey(cred: GoogleOauthApiKeyCredential): string {
  if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) {
    return "";
  }
  return JSON.stringify({
    token: cred.access,
    projectId: cred.projectId,
  });
}

async function loadGoogleGeminiCliProvider(): Promise<ProviderPlugin> {
  if (!googleGeminiCliProviderPromise) {
    googleGeminiCliProviderPromise = import("./gemini-cli-provider.js").then((mod) => {
      let provider: ProviderPlugin | undefined;
      mod.registerGoogleGeminiCliProvider({
        registerProvider(entry) {
          provider = entry;
        },
      } as Pick<OpenClawPluginApi, "registerProvider"> as OpenClawPluginApi);
      if (!provider) {
        throw new Error("google gemini cli provider missing provider registration");
      }
      return provider;
    });
  }
  return await googleGeminiCliProviderPromise;
}

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

function createLazyGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: GOOGLE_GEMINI_CLI_PROVIDER_ID,
    label: GOOGLE_GEMINI_CLI_PROVIDER_LABEL,
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [...GOOGLE_GEMINI_CLI_ENV_VARS],
    auth: [
      {
        id: "oauth",
        label: "Google OAuth",
        hint: "PKCE + localhost callback",
        kind: "oauth",
        run: async (ctx: ProviderAuthContext) => {
          const provider = await loadGoogleGeminiCliProvider();
          const authMethod = provider.auth?.[0];
          if (!authMethod || authMethod.kind !== "oauth") {
            return { profiles: [] };
          }
          return await authMethod.run(ctx);
        },
      },
    ],
    wizard: {
      setup: {
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        choiceHint: "Google OAuth with project-aware token payload",
        methodId: "oauth",
      },
    },
    resolveDynamicModel: (ctx) =>
      resolveGoogle31ForwardCompatModel({ providerId: GOOGLE_GEMINI_CLI_PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    formatApiKey: (cred) => formatGoogleOauthApiKey(cred as GoogleOauthApiKeyCredential),
    resolveUsageAuth: async (ctx) => {
      const provider = await loadGoogleGeminiCliProvider();
      return await provider.resolveUsageAuth?.(ctx);
    },
    fetchUsageSnapshot: async (ctx: ProviderFetchUsageSnapshotContext) => {
      const provider = await loadGoogleGeminiCliProvider();
      if (!provider.fetchUsageSnapshot) {
        throw new Error("google gemini cli provider missing usage snapshot handler");
      }
      return await provider.fetchUsageSnapshot(ctx);
    },
  };
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
    api.registerProvider({
      id: "google",
      label: "Google AI Studio",
      docsPath: "/providers/models",
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
      resolveDynamicModel: (ctx) =>
        resolveGoogle31ForwardCompatModel({ providerId: "google", ctx }),
      wrapStreamFn: (ctx) => createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel),
      isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    });
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    api.registerProvider(createLazyGoogleGeminiCliProvider());
    api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(createLazyGoogleMediaUnderstandingProvider());
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
