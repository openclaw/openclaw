// Opencode Go plugin entrypoint registers its OpenClaw integration.
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveFirstProviderCatalogAuth } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { opencodeGoMediaUnderstandingProvider } from "./media-understanding-provider.js";
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
// Console Go fronts models whose upstream guard rejects prompts with HTTP 400
// "data_inspection_failed". The verdict is content-independent and not stable
// across identical retries, so it is an upstream refusal rather than a payload
// one, and generic 400 handling would otherwise make it a terminal format
// failure that strands the run instead of failing over.
//
// "overloaded" rather than the more obvious "server_error": on HTTP 400 the
// status classifier keeps any provider-supplied reason except "server_error",
// which it rewrites back to "format". "overloaded" also stays clear of the
// auth-profile cooldown and session-suspension paths that "rate_limit" drives.
const DATA_INSPECTION_FAILED_RE = /\bdata[_\s-]?inspection[_\s-]?failed\b/i;

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
        "Go focuses on Kimi, GLM, and MiniMax coding models.",
        "Get your API key at: https://opencode.ai/auth",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
        api: providerConfig.api,
        baseUrl: providerConfig.baseUrl,
      });
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeResolvedModel: ({ model }) => {
      const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
        api: model.api,
        baseUrl: model.baseUrl,
      });
      const baseUrlNormalized =
        normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl
          ? { ...model, baseUrl: normalizedBaseUrl }
          : model;
      const modelNormalized = normalizeOpencodeGoResolvedModel(baseUrlNormalized);
      if (modelNormalized) {
        return modelNormalized;
      }
      return baseUrlNormalized !== model ? baseUrlNormalized : undefined;
    },
    normalizeTransport: ({ api: apiLocal, baseUrl }) => {
      const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({ api: apiLocal, baseUrl });
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api: apiLocal,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    classifyFailoverReason: ({ provider, errorMessage }) => {
      if (provider?.trim().toLowerCase() !== PROVIDER_ID) {
        return undefined;
      }
      return DATA_INSPECTION_FAILED_RE.test(errorMessage) ? "overloaded" : undefined;
    },
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
    api.registerMediaUnderstandingProvider(opencodeGoMediaUnderstandingProvider);
  },
});
