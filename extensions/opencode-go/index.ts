import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveFirstProviderCatalogAuth } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { OPENCODE_GO_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  listOpencodeGoModelCatalogEntries,
  normalizeOpencodeGoBaseUrl,
  normalizeOpencodeGoResolvedModel,
  resolveOpencodeGoModel,
  resolveOpencodeGoStarterModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { createOpencodeGoWireWrapper, createOpencodeGoWrapper } from "./stream.js";

const PROVIDER_ID = "opencode-go";

function normalizeGoBaseUrl<T extends { api?: string | null; baseUrl?: string }>(value: T) {
  const baseUrl = normalizeOpencodeGoBaseUrl(value);
  return baseUrl && baseUrl !== value.baseUrl ? { ...value, baseUrl } : undefined;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  description: "Official OpenCode Go provider plugin",
  manifest,
  provider: {
    label: "OpenCode Go",
    docsPath: "/providers/models",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    manifestAuth: {
      hint: "Shared API key infrastructure for Zen + Go",
      promptMessage: "Enter OpenCode API key",
      profileIds: ["opencode:default", "opencode-go:default"],
      defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
      resolveDefaultModel: async ({ apiKey, signal }) =>
        await resolveOpencodeGoStarterModel({
          apiKey,
          preferredModelRef: OPENCODE_GO_DEFAULT_MODEL_REF,
          ...(signal ? { signal } : {}),
        }),
      expectedProviders: ["opencode", "opencode-go"],
      noteMessage: [
        "OpenCode Go is a separate paid subscription that uses the shared OpenCode API key.",
        "Go includes DeepSeek, Kimi, GLM, Qwen, MiniMax, and other coding models.",
        "Get your API key at: https://opencode.ai/auth",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    normalizeConfig: ({ providerConfig }) => normalizeGoBaseUrl(providerConfig),
    normalizeResolvedModel: ({ model }) => {
      const baseUrlNormalized = normalizeGoBaseUrl(model);
      return normalizeOpencodeGoResolvedModel(baseUrlNormalized ?? model) ?? baseUrlNormalized;
    },
    normalizeTransport: ({ api, baseUrl }) => normalizeGoBaseUrl({ api, baseUrl }),
    resolveDynamicModel: ({ modelId }) => resolveOpencodeGoModel(modelId),
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds !== undefined && !ctx.providerIds.includes(PROVIDER_ID)) {
          return null;
        }
        const auth = resolveFirstProviderCatalogAuth(ctx.resolveProviderApiKey, [
          PROVIDER_ID,
          "opencode",
        ]);
        if (!auth) {
          return null;
        }
        if (!auth.discoveryApiKey) {
          return {
            provider: buildStaticOpencodeGoProviderConfig(auth.apiKey),
          };
        }
        return await runLiveProviderCatalog({
          providerId: PROVIDER_ID,
          profileId: auth.profileId,
          run: async () => ({
            provider: await buildOpencodeGoLiveProviderConfig({
              apiKey: auth.apiKey ?? auth.discoveryApiKey,
              discoveryApiKey: auth.discoveryApiKey,
            }),
          }),
        });
      },
    },
    augmentModelCatalog: () => listOpencodeGoModelCatalogEntries(),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    resolveThinkingProfile,
    resolveTransportTurnState: (ctx) => {
      if (!normalizeOpencodeGoBaseUrl({ api: ctx.model?.api, baseUrl: ctx.model?.baseUrl })) {
        return undefined;
      }
      if (
        Object.keys(ctx.model?.headers ?? {}).some(
          (name) => name.toLowerCase() === "x-opencode-session",
        )
      ) {
        return undefined;
      }
      const sessionId = ctx.sessionId?.trim() || ctx.turnId.trim();
      return sessionId ? { headers: { "x-opencode-session": sessionId } } : undefined;
    },
    wrapStreamFn: createOpencodeGoWrapper,
    wrapSimpleCompletionStreamFn: createOpencodeGoWireWrapper,
    isModernModelRef: () => true,
  },
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "opencode-go",
      capabilities: ["image"],
      defaultModels: {
        image: "kimi-k2.7-code",
      },
      describeImage: undefined,
      describeImages: undefined,
    });
  },
});
