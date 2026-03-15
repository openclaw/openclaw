import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const PROVIDER_ID = "mistral";

const mistralPlugin = {
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Bundled Mistral provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Mistral",
      docsPath: "/providers/models",
      envVars: ["MISTRAL_API_KEY"],
      auth: [],
      capabilities: {
        transcriptToolCallIdMode: "strict9",
        transcriptToolCallIdModelHints: [
          "mistral",
          "mixtral",
          "codestral",
          "pixtral",
          "devstral",
          "ministral",
          "mistralai",
        ],
      },
    });
  },
};

export default mistralPlugin;
