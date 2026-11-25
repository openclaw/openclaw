import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  fetchDeepSeekUsage,
  resolveProviderUsageApiKeyAuth,
} from "openclaw/plugin-sdk/provider-usage";
import { isDeepSeekV4ModelId } from "./models.js";
import { applyDeepSeekConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildDeepSeekProvider } from "./provider-catalog.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";
import { createDeepSeekWebSearchProvider } from "./web-search-provider.js";

const PROVIDER_ID = "deepseek";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepSeek Provider",
  description: "Bundled DeepSeek provider plugin",
  manifest,
  register(api) {
    // Search reads the prepared credential from each request, not registration config.
    api.registerReload({ hotPrefixes: ["plugins.entries.deepseek.config.webSearch.apiKey"] });
    api.registerWebSearchProvider(createDeepSeekWebSearchProvider());
  },
  provider: {
    label: "DeepSeek",
    docsPath: "/providers/deepseek",
    manifestAuth: { applyConfig: applyDeepSeekConfig },
    catalog: {
      discoveryMode: "strict",
      buildProvider: buildDeepSeekProvider,
      buildStaticProvider: buildDeepSeekProvider,
      liveModelDiscovery: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("deepseek"),
    wrapStreamFn: (ctx) => createDeepSeekV4ThinkingWrapper(ctx.streamFn, ctx.thinkingLevel),
    isModernModelRef: ({ modelId }) => isDeepSeekV4ModelId(modelId),
    resolveUsageAuth: (ctx) => resolveProviderUsageApiKeyAuth(ctx, [ctx.env.DEEPSEEK_API_KEY]),
    fetchUsageSnapshot: async (ctx) =>
      await fetchDeepSeekUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
  },
});
