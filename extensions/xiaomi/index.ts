import { streamSimple } from "@mariozechner/pi-ai";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { PROVIDER_LABELS } from "openclaw/plugin-sdk/provider-usage";
import { applyXiaomiConfig, XIAOMI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXiaomiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "xiaomi";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Bundled Xiaomi provider plugin",
  provider: {
    label: "Xiaomi",
    docsPath: "/providers/xiaomi",
    auth: [
      {
        methodId: "api-key",
        label: "Xiaomi API key",
        hint: "API key",
        optionKey: "xiaomiApiKey",
        flagName: "--xiaomi-api-key",
        envVar: "XIAOMI_API_KEY",
        promptMessage: "Enter Xiaomi API key",
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXiaomiConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildXiaomiProvider,
    },
    resolveUsageAuth: async (ctx) => {
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        envDirect: [ctx.env.XIAOMI_API_KEY],
      });
      return apiKey ? { token: apiKey } : null;
    },
    fetchUsageSnapshot: async () => ({
      provider: "xiaomi",
      displayName: PROVIDER_LABELS.xiaomi,
      windows: [],
    }),
    wrapStreamFn: (ctx) => {
      // MiMo reasoning models (mimo-v2-pro, mimo-v2-omni) output the full
      // response to `reasoning_content` with an empty `content` field, which
      // causes OpenClaw to emit no visible text to the user. Setting
      // `enable_thinking: false` in the request payload tells the model to
      // write its reply to the standard `content` field instead.
      if (!ctx.model?.reasoning) {
        return null;
      }
      const underlying = ctx.streamFn ?? streamSimple;
      return (model, context, options) => {
        const originalOnPayload = options?.onPayload;
        return underlying(model, context, {
          ...options,
          onPayload: (payload) => {
            if (payload && typeof payload === "object") {
              (payload as Record<string, unknown>).enable_thinking = false;
            }
            return originalOnPayload?.(payload, model);
          },
        });
      };
    },
  },
});
