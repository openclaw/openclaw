import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyMeganovaConfig, MEGANOVA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMeganovaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "meganova";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "MegaNova Provider",
  description: "Bundled MegaNova AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "MegaNova AI",
      docsPath: "/providers/meganova",
      envVars: ["MEGANOVA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "MegaNova AI API key",
          hint: "API key (30+ models)",
          optionKey: "meganovaApiKey",
          flagName: "--meganova-api-key",
          envVar: "MEGANOVA_API_KEY",
          promptMessage: "Enter MegaNova API key",
          defaultModel: MEGANOVA_DEFAULT_MODEL_REF,
          expectedProviders: ["meganova"],
          applyConfig: (cfg) => applyMeganovaConfig(cfg),
          noteMessage: [
            "MegaNova AI provides access to 30+ leading models through an OpenAI-compatible API,",
            "including Claude, GPT-5, Gemini, DeepSeek, Llama, Qwen, and more.",
            "Get your API key at: https://meganova.ai",
          ].join("\n"),
          noteTitle: "MegaNova AI",
          wizard: {
            choiceId: "meganova-api-key",
            choiceLabel: "MegaNova AI API key",
            groupId: "meganova",
            groupLabel: "MegaNova AI",
            groupHint: "API key (30+ models)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildMeganovaProvider,
          }),
      },
    });
  },
});
