import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const PROVIDER_ID = "opencode";
const MINIMAX_PREFIX = "minimax-m2.5";

function isModernOpencodeModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !lower.startsWith(MINIMAX_PREFIX);
}

const opencodePlugin = {
  id: PROVIDER_ID,
  name: "OpenCode Zen Provider",
  description: "Bundled OpenCode Zen provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Zen",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [],
      capabilities: {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      },
      isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
    });
  },
};

export default opencodePlugin;
