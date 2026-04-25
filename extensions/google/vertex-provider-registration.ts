import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeGoogleModelId } from "./model-id.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";
import { resolveGoogleGenerativeAiTransport } from "./provider-policy.js";
import { createGoogleGenerativeAiTransportStreamFn } from "./transport-stream.js";
import {
  buildGoogleVertexProvider,
  mergeImplicitGoogleVertexProvider,
} from "./vertex-provider-catalog.js";
import {
  GOOGLE_VERTEX_CREDENTIALS_MARKER,
  hasGoogleVertexAvailableAuth,
  resolveGoogleVertexConfigApiKey,
} from "./vertex-region.js";

const PROVIDER_ID = "google-vertex";

export function buildGoogleVertexProviderPlugin(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Google Vertex AI",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (!hasGoogleVertexAvailableAuth(ctx.env)) {
          return null;
        }
        const implicit = buildGoogleVertexProvider({ env: ctx.env });
        return {
          provider: mergeImplicitGoogleVertexProvider({
            existing: ctx.config.models?.providers?.[PROVIDER_ID],
            implicit,
          }),
        };
      },
    },
    resolveConfigApiKey: ({ env }) => resolveGoogleVertexConfigApiKey(env),
    resolveSyntheticAuth: () => {
      if (!hasGoogleVertexAvailableAuth()) {
        return undefined;
      }
      return {
        apiKey: GOOGLE_VERTEX_CREDENTIALS_MARKER,
        source: "gcp-vertex-credentials (ADC)",
        mode: "api-key",
      };
    },
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
    createStreamFn: ({ model }) =>
      model.api === "google-generative-ai"
        ? createGoogleGenerativeAiTransportStreamFn()
        : undefined,
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  };
}

export function registerGoogleVertexProvider(api: OpenClawPluginApi) {
  api.registerProvider(buildGoogleVertexProviderPlugin());
}
