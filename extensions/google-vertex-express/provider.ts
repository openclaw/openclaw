import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  type ModelDefinitionConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyVertexExpressConfig,
  VERTEX_EXPRESS_BASE_URL,
  VERTEX_EXPRESS_DEFAULT_MODEL_REF,
  VERTEX_EXPRESS_MODELS,
  VERTEX_EXPRESS_PROVIDER_ID,
} from "./onboard.js";
import { createVertexExpressTransportStreamFn } from "./transport.js";

// ---------------------------------------------------------------------------
// Static model catalog
// ---------------------------------------------------------------------------

/**
 * Static catalog used for onboarding / model pickers.
 *
 * These models are shown before the user's API key is validated and cover the
 * complete set offered by Google Vertex AI Express Mode.
 */
const STATIC_MODEL_CATALOG: ModelDefinitionConfig[] = VERTEX_EXPRESS_MODELS.map((m) => ({
  id: m.id,
  name: m.label,
  api: "google-generative-ai" as const,
  baseUrl: VERTEX_EXPRESS_BASE_URL,
  reasoning: false,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1024 * 1024,
  maxTokens: 8192,
}));

// ---------------------------------------------------------------------------
// Provider plugin
// ---------------------------------------------------------------------------

const GOOGLE_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: "google-gemini" });

export function buildGoogleVertexExpressProvider(): ProviderPlugin {
  return {
    id: VERTEX_EXPRESS_PROVIDER_ID,
    label: "Google Vertex AI (Express Mode)",
    docsPath: "/providers/models",
    envVars: ["GOOGLE_VERTEX_EXPRESS_API_KEY"],

    // Auth: API key entry in the wizard, non-interactive CLI flag support.
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: VERTEX_EXPRESS_PROVIDER_ID,
        methodId: "api-key",
        label: "Google Vertex AI Express Mode API key",
        hint: "Global Vertex AI endpoint with API key authentication",
        optionKey: "vertexExpressApiKey",
        flagName: "--google-vertex-express-api-key",
        envVar: "GOOGLE_VERTEX_EXPRESS_API_KEY",
        promptMessage: "Enter your Google Cloud API Key:",
        expectedProviders: [VERTEX_EXPRESS_PROVIDER_ID],
        wizard: {
          choiceId: "google-vertex-express-api-key",
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
          },
        },
        applyConfig: (cfg) => applyVertexExpressConfig(cfg),
      }),
    ],

    // Static catalog — shown in onboarding and the model picker before the
    // live catalog fetch runs.
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: {
          api: "google-generative-ai",
          baseUrl: VERTEX_EXPRESS_BASE_URL,
          models: STATIC_MODEL_CATALOG,
        },
      }),
    },

    augmentModelCatalog: () =>
      STATIC_MODEL_CATALOG.map((m) => ({
        provider: VERTEX_EXPRESS_PROVIDER_ID,
        ...m,
      })),

    // Replay / compaction: same transcript rules as Google AI Studio.
    ...GOOGLE_GEMINI_REPLAY_HOOKS,

    // Custom stream factory: routes requests to the Vertex Express endpoint.
    createStreamFn: ({ model }) =>
      model.api === "google-generative-ai" ? createVertexExpressTransportStreamFn() : undefined,

    // Model-id normalization: strip accidental provider prefix if present.
    normalizeModelId: ({ modelId }) => {
      const prefix = `${VERTEX_EXPRESS_PROVIDER_ID}/`;
      return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : undefined;
    },

    // Mark all models in this provider as "modern" for live/smoke filters.
    isModernModelRef: () => true,
  };
}
