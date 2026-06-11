// CoreWeave Serverless Inference plugin entrypoint (formerly Weights & Biases Inference).
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyCoreweaveConfig, COREWEAVE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildCoreweaveProvider, buildStaticCoreweaveProvider } from "./provider-catalog.js";

const PROVIDER_ID = "coreweave";

/** Reads the optional `team/project` openai-project scope from plugin config. */
function resolveProjectScope(ctx: {
  config?: Parameters<typeof resolvePluginConfigObject>[0];
}): string | undefined {
  return normalizeOptionalString(resolvePluginConfigObject(ctx.config, PROVIDER_ID)?.project);
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "CoreWeave Serverless Inference Provider",
  description: "Bundled CoreWeave Serverless Inference provider plugin",
  provider: {
    label: "CoreWeave Serverless Inference",
    docsPath: "/providers/coreweave",
    auth: [
      {
        methodId: "api-key",
        label: "CoreWeave Serverless Inference API key",
        hint: "Open models on CoreWeave GPUs (formerly Weights & Biases Inference)",
        optionKey: "coreweaveApiKey",
        flagName: "--coreweave-api-key",
        envVar: "COREWEAVE_API_KEY",
        promptMessage: "Enter CoreWeave Serverless Inference API key",
        defaultModel: COREWEAVE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyCoreweaveConfig(cfg),
        noteTitle: "CoreWeave Serverless Inference",
        noteMessage: [
          "CoreWeave Serverless Inference (formerly Weights & Biases Inference) serves",
          "open models on CoreWeave GPUs through an OpenAI-compatible API.",
          "Get your API key at: https://wandb.ai/authorize",
          "Optional: set the plugin `project` config ('team/project') to attribute usage;",
          "otherwise W&B uses your default entity and an 'inference' project.",
        ].join("\n"),
        wizard: {
          groupLabel: "CoreWeave Serverless Inference",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        // Optional W&B usage attribution: when set, openai-project scopes every
        // request (chat AND model discovery). When unset, W&B applies the default
        // entity and an 'inference' project, so no header is sent.
        const project = resolveProjectScope(ctx);
        return {
          provider: {
            ...(await buildCoreweaveProvider(apiKey, project)),
            apiKey,
            ...(project ? { headers: { "openai-project": project } } : {}),
          },
        };
      },
      staticRun: async () => ({
        provider: buildStaticCoreweaveProvider(),
      }),
    },
  },
});
