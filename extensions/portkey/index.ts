import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildPortkeyImageGenerationProvider } from "./image-generation-provider.js";
import { applyPortkeyConfig, PORTKEY_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildPortkeyProvider } from "./provider-catalog.js";

const PROVIDER_ID = "portkey";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Portkey Provider",
  description: "Bundled Portkey provider plugin",
  provider: {
    label: "Portkey",
    docsPath: "/providers/portkey",
    auth: [
      {
        methodId: "api-key",
        label: "Portkey API key",
        hint: "AI gateway for 250+ LLM providers",
        optionKey: "portkeyApiKey",
        flagName: "--portkey-api-key",
        envVar: "PORTKEY_API_KEY",
        promptMessage: "Enter Portkey API key",
        defaultModel: PORTKEY_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyPortkeyConfig(cfg),
        noteTitle: "Portkey",
        noteMessage: [
          "Portkey provides an AI gateway to 250+ LLM providers.",
          "Get your API key from https://app.portkey.ai",
          "Docs: https://docs.portkey.ai",
        ].join("\n"),
        wizard: {
          groupHint: "AI gateway with observability and routing (250+ providers)",
        },
      },
    ],
    catalog: {
      buildProvider: buildPortkeyProvider,
      allowExplicitBaseUrl: true,
    },
  },
  register(api) {
    api.registerImageGenerationProvider(buildPortkeyImageGenerationProvider());
  },
});
