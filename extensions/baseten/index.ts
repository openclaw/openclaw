import { streamSimple } from "openclaw/plugin-sdk/llm";
import type {
  ProviderThinkingProfile,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOpenAICompatibleReasoningReplay,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildBasetenDecisionProvider } from "./decision-provider.js";
import {
  BASETEN_BASE_URL,
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
  usesBasetenChatTemplateThinking,
} from "./models.js";
import { applyBasetenSetupConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildStaticBasetenProvider } from "./provider-catalog.js";

const PROVIDER_ID = "baseten";

function createBasetenThinkingWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    // Standalone completions use dispatch aliases; the source API owns wire policy.
    if (model.provider !== "baseten" || (ctx.sourceApi ?? model.api) !== "openai-completions") {
      return underlying(model, context, options);
    }
    const affinity = options?.promptCacheKey ?? options?.sessionId;
    const cacheRetention = options?.cacheRetention ?? ctx.extraParams?.cacheRetention;
    let streamOptions = options;
    if (
      affinity &&
      cacheRetention !== "none" &&
      model.baseUrl?.trim().replace(/\/+$/u, "") === BASETEN_BASE_URL &&
      !Object.keys({ ...model.headers, ...options?.headers }).some(
        (name) => name.toLowerCase() === "x-session-affinity",
      )
    ) {
      streamOptions = {
        ...options,
        headers: { ...options?.headers, "x-session-affinity": affinity },
      };
    }
    const optIn = usesBasetenChatTemplateThinking(model.id);
    const thinkingLevel =
      options?.reasoning ??
      (ctx.thinkingLevel === "adaptive" ? "max" : ctx.thinkingLevel) ??
      (optIn ? "off" : undefined);
    // Resolve before serialization so scalar effort agrees with the opt-in toggle.
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      thinkingLevel === undefined ? streamOptions : { ...streamOptions, reasoning: thinkingLevel },
      (payload) => {
        const normalizedModelId = model.id.trim().toLowerCase();
        if (
          normalizedModelId === "deepseek-ai/deepseek-v4-pro" ||
          normalizedModelId === "deepseek-ai/deepseek-v4-pro-0813"
        ) {
          // DeepSeek defaults on; only explicit off may remove required replay metadata.
          normalizeOpenAICompatibleReasoningReplay(payload, {
            thinkingEnabled: thinkingLevel !== "off",
            stripAssistantMessagesOnly: true,
            replaceNullReasoningContent: true,
          });
          // The current Pro endpoint requires this envelope whenever scalar effort is present,
          // and rejects an enabled envelope next to effort "none".
          if (
            normalizedModelId === "deepseek-ai/deepseek-v4-pro-0813" &&
            payload.reasoning_effort !== undefined
          ) {
            payload.thinking = {
              type: payload.reasoning_effort === "none" ? "disabled" : "enabled",
            };
          }
        }
        if (optIn) {
          payload.chat_template_args = {
            ...asNonArrayRecord(payload.chat_template_args),
            enable_thinking: thinkingLevel !== "off",
          };
        }
      },
    );
  };
}

const BASETEN_BINARY_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

const BASETEN_GLM_52_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

const BASETEN_DEEPSEEK_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
} as const satisfies ProviderThinkingProfile;

const BASETEN_DEEPSEEK_V41_THINKING_PROFILE = {
  ...BASETEN_DEEPSEEK_THINKING_PROFILE,
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Baseten Provider",
  description: "Official Baseten Model APIs provider plugin",
  manifest,
  register(api) {
    api.registerDecisionProvider(buildBasetenDecisionProvider());
  },
  provider: {
    label: "Baseten",
    docsPath: "/providers/baseten",
    manifestAuth: {
      applyConfig: applyBasetenSetupConfig,
      preserveExistingPrimary: true,
      noteTitle: "Baseten",
      noteMessage: [
        "Baseten hosts DeepSeek V4.1 Flash and other models behind one OpenAI-compatible API.",
        "Get your API key at: https://app.baseten.co/settings/api_keys",
      ].join("\n"),
    },
    catalog: {
      order: "simple",
      run: async (ctx: ProviderCatalogContext) => {
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderAuth(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        if (!discoveryApiKey) {
          return { provider: { ...buildStaticBasetenProvider(), apiKey } };
        }
        return await buildOpenAICompatibleLiveProviderCatalog({
          discoveryMode: "strict",
          providerId: PROVIDER_ID,
          providerConfig: buildStaticBasetenProvider(),
          apiKey,
          discoveryApiKey,
          profileId,
          modelDiscovery: {
            timeoutMs: 10_000,
            ttlMs: 5 * 60 * 1000,
            projectRows: projectBasetenLiveModels,
          },
        });
      },
      staticRun: async () => ({ provider: buildStaticBasetenProvider() }),
    },
    resolveDynamicModel: ({ modelId }) => resolveBasetenDynamicModel(modelId),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    wrapStreamFn: createBasetenThinkingWrapper,
    wrapSimpleCompletionStreamFn: createBasetenThinkingWrapper,
    resolveThinkingProfile: ({ modelId }) => {
      const normalized = modelId.trim().toLowerCase();
      if (normalized === "deepseek-ai/deepseek-v4.1-flash") {
        return BASETEN_DEEPSEEK_V41_THINKING_PROFILE;
      }
      if (normalized === "deepseek-ai/deepseek-v4-pro-0813") {
        return BASETEN_DEEPSEEK_THINKING_PROFILE;
      }
      if (normalized === "zai-org/glm-5.2" || normalized === "zai-org/glm-5.2-fast") {
        return BASETEN_GLM_52_THINKING_PROFILE;
      }
      return usesBasetenChatTemplateThinking(normalized)
        ? BASETEN_BINARY_THINKING_PROFILE
        : undefined;
    },
    isModernModelRef: () => true,
  },
});
