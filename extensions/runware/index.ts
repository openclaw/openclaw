// Runware plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyRunwareApiKeyConfig, RUNWARE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildRunwareProvider, buildStaticRunwareProvider } from "./provider-catalog.js";
import { wrapRunwareProviderStream } from "./stream.js";

const PROVIDER_ID = "runware";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Runware Provider",
  description: "Bundled Runware provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Runware",
      docsPath: "/providers/runware",
      envVars: ["RUNWARE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Runware API key",
          hint: "OpenAI-compatible access to DeepSeek, Kimi, GLM, Grok, and more",
          optionKey: "runwareApiKey",
          flagName: "--runware-api-key",
          envVar: "RUNWARE_API_KEY",
          promptMessage: "Enter Runware API key",
          defaultModel: RUNWARE_DEFAULT_MODEL_REF,
          applyConfig: (cfg) => applyRunwareApiKeyConfig(cfg),
          noteTitle: "Runware",
          noteMessage: [
            "Runware provides OpenAI-compatible access to a live-updated catalog of models.",
            "Get your API key at: https://my.runware.ai/api-keys",
          ].join("\n"),
          wizard: {
            choiceId: "runware-api-key",
            choiceLabel: "Runware API key",
            groupId: "runware",
            groupLabel: "Runware",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "profile",
        run: async (ctx) => {
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildRunwareProvider(discoveryApiKey ?? apiKey)),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "profile",
        run: async () => ({ provider: buildStaticRunwareProvider() }),
      },
      ...buildProviderReplayFamilyHooks({
        family: "openai-compatible",
        dropReasoningFromHistory: false,
      }),
      wrapStreamFn: wrapRunwareProviderStream,
    });
  },
});
