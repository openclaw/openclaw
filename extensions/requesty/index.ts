// Requesty plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  DEFAULT_CONTEXT_TOKENS,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { normalizeRequestyApiModelId } from "./models.js";
import { applyRequestyConfig, REQUESTY_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildRequestyProvider,
  normalizeRequestyBaseUrl,
  projectRequestyModelCapabilities,
  REQUESTY_BASE_URL,
  REQUESTY_FALLBACK_CONTEXT_WINDOW,
  REQUESTY_FALLBACK_COST,
  REQUESTY_FALLBACK_MAX_OUTPUT,
  REQUESTY_MODELS_URL,
  type RequestyModelCapabilities,
} from "./provider-catalog.js";

const PROVIDER_ID = "requesty";
const REQUESTY_MODEL_DISCOVERY_TTL_MS = 60_000;

// Requesty is an OpenAI-compatible router, so the proxy-Gemini replay family and
// the OpenRouter-style reasoning stream wrapper apply unchanged. Reuse the shared
// family builders (the same ones the bundled openrouter/kilocode/opencode plugins
// use) instead of re-implementing provider-local wrappers.
const REQUESTY_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("openrouter-thinking");

// Per-id capability cache populated by prepareDynamicModel via the live
// `/v1/models` payload, so resolveDynamicModel can stay synchronous.
const requestyModelCapabilitiesById = new Map<string, RequestyModelCapabilities>();

function readRequestyModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = (row as { id?: unknown }).id;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

async function loadRequestyModelCapabilities(apiModelId: string, apiKey?: string): Promise<void> {
  if (!apiKey || requestyModelCapabilitiesById.has(apiModelId)) {
    return;
  }
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: REQUESTY_MODELS_URL,
      apiKey,
      ttlMs: REQUESTY_MODEL_DISCOVERY_TTL_MS,
      auditContext: "requesty-model-discovery",
    });
    for (const row of rows) {
      const rowId = readRequestyModelId(row);
      const capabilities = projectRequestyModelCapabilities(row);
      if (rowId && capabilities) {
        requestyModelCapabilitiesById.set(rowId, capabilities);
      }
    }
  } catch (error) {
    // Capability discovery is advisory. Fall back to sensible defaults when the
    // router is unreachable or returns an unexpected body.
    if (!(error instanceof LiveModelCatalogHttpError)) {
      throw error;
    }
  }
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Requesty Provider",
  description: "Bundled Requesty provider plugin",
  register(api) {
    function buildDynamicRequestyModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const apiModelId = normalizeRequestyApiModelId(ctx.modelId) ?? ctx.modelId;
      const capabilities = requestyModelCapabilitiesById.get(apiModelId);
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: REQUESTY_BASE_URL,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? ["text"],
        ...(capabilities?.supportsTools !== undefined
          ? { compat: { supportsTools: capabilities.supportsTools } }
          : {}),
        cost: REQUESTY_FALLBACK_COST,
        contextWindow: capabilities?.contextWindow ?? REQUESTY_FALLBACK_CONTEXT_WINDOW,
        maxTokens: capabilities?.maxTokens ?? REQUESTY_FALLBACK_MAX_OUTPUT,
      };
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Requesty",
      docsPath: "/providers/models",
      envVars: ["REQUESTY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Requesty API key",
          hint: "API key from app.requesty.ai/api-keys",
          optionKey: "requestyApiKey",
          flagName: "--requesty-api-key",
          envVar: "REQUESTY_API_KEY",
          promptMessage: "Enter Requesty API key",
          defaultModel: REQUESTY_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyRequestyConfig(cfg),
          wizard: {
            choiceId: "requesty-api-key",
            choiceLabel: "Requesty API key",
            groupId: "requesty",
            groupLabel: "Requesty",
            groupHint: "API key",
            onboardingScopes: ["text-inference"],
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildRequestyProvider(),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildRequestyProvider(),
        }),
      },
      resolveDynamicModel: (ctx) => buildDynamicRequestyModel(ctx),
      prepareDynamicModel: async (ctx) => {
        const resolveApiKey = (
          ctx as {
            resolveProviderApiKey?: (providerId?: string) => { apiKey: string | undefined };
          }
        ).resolveProviderApiKey;
        const apiKey = resolveApiKey?.(PROVIDER_ID)?.apiKey;
        await loadRequestyModelCapabilities(
          normalizeRequestyApiModelId(ctx.modelId) ?? ctx.modelId,
          apiKey,
        );
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalizedBaseUrl = normalizeRequestyBaseUrl(providerConfig.baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      normalizeTransport: ({ api: apiLocal, baseUrl }) => {
        const normalizedBaseUrl = normalizeRequestyBaseUrl(baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
          ? { api: apiLocal, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      isModernModelRef: () => true,
      wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
        REQUESTY_THINKING_STREAM_HOOKS.wrapStreamFn?.(ctx) ?? ctx.streamFn,
    });
  },
});

export { DEFAULT_CONTEXT_TOKENS };
