import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import {
  buildProviderReplayFamilyHooks,
  isProxyReasoningUnsupportedModelHint,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOpenAICompatibleReasoningPayload,
  wrapProviderPayloadHook,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  asOptionalRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyKilocodeConfig, KILOCODE_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildKilocodeProvider, buildKilocodeProviderWithDiscovery } from "./provider-catalog.js";

const PROVIDER_ID = "kilocode";

function normalizeKilocodeStopAfterCaller(
  value: unknown,
  fallbackPayload: Record<string, unknown> | undefined,
): unknown {
  const payload = asOptionalRecord(value) ?? fallbackPayload;
  if (typeof payload?.stop === "string") {
    payload.stop = [payload.stop];
  }
  return value;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Kilo Gateway Provider",
  description: "Bundled Kilo Gateway provider plugin",
  manifest,
  provider: {
    label: "Kilo Gateway",
    docsPath: "/providers/kilocode",
    manifestAuth: {
      defaultModel: KILOCODE_DEFAULT_MODEL_REF,
      applyConfig: applyKilocodeConfig,
    },
    catalog: {
      discoveryMode: "strict",
      buildProvider: () => buildKilocodeProviderWithDiscovery({ discoveryMode: "strict" }),
      buildStaticProvider: buildKilocodeProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    wrapStreamFn(ctx) {
      if (normalizeOptionalLowercaseString(ctx.provider) !== "kilocode" || !ctx.streamFn) {
        return undefined;
      }
      const underlying = ctx.streamFn;
      const thinkingLevel =
        ctx.modelId === "kilo-auto/balanced" || isProxyReasoningUnsupportedModelHint(ctx.modelId)
          ? undefined
          : ctx.thinkingLevel;
      return (model, context, options) => {
        const headers = resolveProviderRequestHeaders({
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          capability: "llm",
          transport: "stream",
          callerHeaders: options?.headers,
          defaultHeaders: {
            "X-KILOCODE-FEATURE": process.env.KILOCODE_FEATURE?.trim() || "openclaw",
          },
          precedence: "defaults-win",
        });
        return underlying(model, context, {
          ...options,
          headers,
          onPayload: wrapProviderPayloadHook(
            options?.onPayload,
            (payload, result) =>
              normalizeKilocodeStopAfterCaller(result, asOptionalRecord(payload)),
            (payload) => {
              const payloadObj = asOptionalRecord(payload);
              if (payloadObj) {
                // Caller hooks can override thinking defaults; stop normalization runs afterward.
                normalizeOpenAICompatibleReasoningPayload(payloadObj, thinkingLevel);
              }
            },
          ),
        });
      };
    },
    isCacheTtlEligible: (ctx) => ctx.modelId.startsWith("anthropic/"),
  },
});
