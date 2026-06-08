// Neosantara plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { OPENAI_RESPONSES_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream";
import { applyNeosantaraConfig, NEOSANTARA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNeosantaraProvider } from "./provider-catalog.js";

const PROVIDER_ID = "neosantara";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Neosantara Provider",
  description: "Bundled Neosantara provider plugin",
  provider: {
    label: "Neosantara",
    docsPath: "/providers/neosantara",
    hookAliases: ["neosantara-responses"],
    auth: [
      {
        methodId: "api-key",
        label: "Neosantara API key",
        hint: "API key",
        optionKey: "neosantaraApiKey",
        flagName: "--neosantara-api-key",
        envVar: "NEOSANTARA_API_KEY",
        promptMessage: "Enter Neosantara API key",
        defaultModel: NEOSANTARA_DEFAULT_MODEL_REF,
        expectedProviders: ["neosantara", "neosantara-responses"],
        applyConfig: (cfg) => applyNeosantaraConfig(cfg),
        wizard: {
          groupLabel: "Neosantara",
        },
      },
    ],
    catalog: {
      buildProvider: buildNeosantaraProvider,
    },
    normalizeTransport: ({ provider, api, baseUrl }) => {
      const isNeosantara = provider === PROVIDER_ID || provider === "neosantara-responses";
      const isNeosantaraUrl = baseUrl === "https://api.neosantara.xyz/v1";
      if (
        (isNeosantara || isNeosantaraUrl) &&
        (api === "openai-completions" || api === "openai-responses")
      ) {
        return { api, baseUrl: baseUrl ?? "https://api.neosantara.xyz/v1" };
      }
      return undefined;
    },
    wrapStreamFn: (ctx) => {
      if (ctx.model?.api === "openai-responses") {
        return OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn?.(ctx) ?? ctx.streamFn;
      }
      return ctx.streamFn;
    },
    classifyFailoverReason: ({ errorMessage }) =>
      /\bconcurrency limit\b.*\b(?:breached|reached)\b/i.test(errorMessage)
        ? "rate_limit"
        : undefined,
  },
});
