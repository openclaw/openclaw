import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeGoogleModelId } from "./model-id.js";
import { GOOGLE_GEMINI_DEFAULT_MODEL, applyGoogleGeminiModelDefault } from "./onboard.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";
import {
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiTransport,
} from "./provider-policy.js";
import {
  createGoogleGenerativeAiTransportStreamFn,
  createGoogleVertexTransportStreamFn,
} from "./transport-stream.js";

const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_GEMINI_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const GOOGLE_GEMINI_TEXT_MODELS: ModelDefinitionConfig[] = [
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
];

function buildGoogleStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_GEMINI_BASE_URL,
    api: "google-generative-ai",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}

export function buildGoogleProvider(): ProviderPlugin {
  return {
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: ["google-antigravity", "google-vertex"],
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
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    staticCatalog: {
      order: "simple",
      run: async () => ({ providers: { google: buildGoogleStaticCatalogProvider() } }),
    },
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: ctx.provider,
        ctx,
      }),
    createStreamFn: ({ model }) => {
      if (model.api === "google-generative-ai") {
        return createGoogleGenerativeAiTransportStreamFn();
      }
      if (model.api === "google-vertex") {
        return createGoogleVertexTransportStreamFn();
      }
      return undefined;
    },
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  };
}

export function registerGoogleProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleProvider());
}

export default buildGoogleProvider();
