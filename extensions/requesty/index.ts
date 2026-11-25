import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyRequestyConfig, REQUESTY_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { REQUESTY_LIVE_MODEL_DISCOVERY } from "./provider-catalog.js";
import { isRequestyAnthropicModel, REQUESTY_PROVIDER_ID } from "./provider-models.js";

// Requesty attributes traffic per client through these headers.
const REQUESTY_ATTRIBUTION_HEADERS = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
} as const;

export default defineSingleProviderPluginEntry({
  id: REQUESTY_PROVIDER_ID,
  name: "Requesty Provider",
  description: "Bundled Requesty provider plugin",
  manifest,
  provider: {
    label: "Requesty",
    docsPath: "/providers/requesty",
    manifestAuth: {
      defaultModel: REQUESTY_DEFAULT_MODEL_REF,
      applyConfig: applyRequestyConfig,
    },
    catalog: {
      discoveryMode: "strict",
      liveModelDiscovery: REQUESTY_LIVE_MODEL_DISCOVERY,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: REQUESTY_PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    wrapStreamFn(ctx) {
      if (
        normalizeOptionalLowercaseString(ctx.provider) !== REQUESTY_PROVIDER_ID ||
        !ctx.streamFn
      ) {
        return undefined;
      }
      const underlying = ctx.streamFn;
      const wrapped: NonNullable<typeof ctx.streamFn> = (model, context, options) =>
        underlying(model, context, {
          ...options,
          headers: resolveProviderRequestHeaders({
            provider: typeof model.provider === "string" ? model.provider : REQUESTY_PROVIDER_ID,
            api: model.api,
            baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
            capability: "llm",
            transport: "stream",
            callerHeaders: options?.headers,
            defaultHeaders: REQUESTY_ATTRIBUTION_HEADERS,
            precedence: "defaults-win",
          }),
        });
      return Object.assign(wrapped, { preservesGenericCompatibility: true });
    },
    isCacheTtlEligible: (ctx) => isRequestyAnthropicModel(ctx.modelId),
  },
});
