import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  parseProviderUsageNonNegativeNumber,
  resolveProviderUsageApiKeyAuth,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { VENICE_BASE_URL, VENICE_MODEL_DISCOVERY_OPTIONS } from "./models.js";
import { applyVeniceConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildStaticVeniceProvider } from "./provider-catalog.js";
import { createVeniceStreamWrapper } from "./stream.js";

const PROVIDER_ID = "venice";
const VENICE_BALANCE_URL = "https://api.venice.ai/api/v1/billing/balance";
const VENICE_USAGE_RESPONSE_MAX_BYTES = 1024 * 1024;

const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
] as const;

function isXaiBackedVeniceModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("grok");
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Venice Provider",
  description: "Bundled Venice provider plugin",
  manifest,
  provider: {
    label: "Venice",
    docsPath: "/providers/venice",
    manifestAuth: {
      applyConfig: applyVeniceConfig,
      noteMessage: [
        "Venice AI provides privacy-focused inference with uncensored models.",
        "Get your API key at: https://venice.ai/settings/api",
        "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
      ].join("\n"),
      noteTitle: "Venice AI",
    },
    catalog: {
      discoveryMode: "strict",
      buildProvider: buildStaticVeniceProvider,
      liveModelDiscovery: VENICE_MODEL_DISCOVERY_OPTIONS,
    },
    normalizeResolvedModel: ({ modelId, model }) => {
      const normalized = isXaiBackedVeniceModel(modelId)
        ? applyModelCompatPatch(model, {
            toolSchemaProfile: "xai",
            unsupportedToolSchemaKeywords: [...XAI_UNSUPPORTED_SCHEMA_KEYWORDS],
            toolCallArgumentsEncoding: "html-entities",
          })
        : model;
      return model.api === "openai-completions" &&
        model.baseUrl?.trim().replace(/\/+$/u, "") === VENICE_BASE_URL
        ? applyModelCompatPatch(normalized, {
            supportsPromptCacheKey: model.compat?.supportsPromptCacheKey ?? true,
            supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? false,
          })
        : normalized;
    },
    wrapStreamFn: (ctx) => createVeniceStreamWrapper(ctx.streamFn),
    resolveUsageAuth: (ctx) => resolveProviderUsageApiKeyAuth(ctx, [ctx.env.VENICE_API_KEY]),
    fetchUsageSnapshot: async (ctx) => {
      let response: Response;
      try {
        response = await ctx.fetchFn(VENICE_BALANCE_URL, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${ctx.token}`,
          },
          signal: AbortSignal.timeout(ctx.timeoutMs),
        });
      } catch {
        return buildUsageErrorSnapshot("venice", "Usage unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return buildUsageHttpErrorSnapshot({ provider: "venice", status: response.status });
      }
      let data: {
        canConsume?: unknown;
        consumptionCurrency?: unknown;
        balances?: {
          diem?: unknown;
          usd?: unknown;
        };
        diemEpochAllocation?: unknown;
      };
      try {
        data = await readProviderJsonObjectResponse(response, "Venice usage", {
          maxBytes: VENICE_USAGE_RESPONSE_MAX_BYTES,
          chunkTimeoutMs: ctx.timeoutMs,
          onIdleTimeout: ({ chunkTimeoutMs }) =>
            new Error(`Venice usage response stalled for ${chunkTimeoutMs}ms`),
        });
      } catch {
        return buildUsageErrorSnapshot("venice", "Malformed usage response");
      }
      const diem = parseProviderUsageNonNegativeNumber(data.balances?.diem);
      const usd = parseProviderUsageNonNegativeNumber(data.balances?.usd);
      const allocation = parseProviderUsageNonNegativeNumber(data.diemEpochAllocation);
      const windows = [];
      if (diem !== undefined && allocation !== undefined && allocation > 0) {
        windows.push({
          label: "DIEM epoch",
          usedPercent: Math.min(100, Math.max(0, ((allocation - diem) / allocation) * 100)),
        });
      }
      const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
      if (diem !== undefined) {
        billing.push({ type: "balance", label: "DIEM balance", amount: diem, unit: "DIEM" });
      }
      if (usd !== undefined) {
        billing.push({ type: "balance", label: "USD balance", amount: usd, unit: "USD" });
      }
      if (diem !== undefined && allocation !== undefined && allocation > 0) {
        billing.push({
          type: "budget",
          label: "DIEM epoch",
          used: Math.max(0, allocation - diem),
          limit: allocation,
          unit: "DIEM",
          period: "epoch",
        });
      }
      const consumptionCurrency =
        typeof data.consumptionCurrency === "string"
          ? data.consumptionCurrency.trim().toUpperCase()
          : "";
      return {
        provider: "venice",
        displayName: "Venice",
        windows,
        ...(billing.length > 0 ? { billing } : {}),
        ...(consumptionCurrency ? { plan: `${consumptionCurrency} billing` } : {}),
        ...(data.canConsume === false ? { summary: "API consumption unavailable" } : {}),
      };
    },
  },
});
