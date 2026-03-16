import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { applyOpencodeGoConfig } from "../../src/commands/onboard-auth.config-opencode-go.js";
import { OPENCODE_GO_DEFAULT_MODEL_REF } from "../../src/commands/opencode-go-model-default.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

const PROVIDER_ID = "opencode-go";

const opencodeGoPlugin = {
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  description: "Bundled OpenCode Go provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Go",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "OpenCode Go catalog",
          hint: "Zen + Go 目录共用 API Key",
          optionKey: "opencodeGoApiKey",
          flagName: "--opencode-go-api-key",
          envVar: "OPENCODE_API_KEY",
          promptMessage: "输入 OpenCode API Key",
          profileIds: ["opencode:default", "opencode-go:default"],
          defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
          expectedProviders: ["opencode", "opencode-go"],
          applyConfig: (cfg) => applyOpencodeGoConfig(cfg),
          noteMessage: [
            "OpenCode 在 Zen 和 Go 目录中共用同一个 API Key。",
            "Go 目录聚焦 Kimi、GLM 和 MiniMax 编码模型。",
            "获取 API Key：https://opencode.ai/auth",
          ].join("\n"),
          noteTitle: "OpenCode",
          wizard: {
            choiceId: "opencode-go",
            choiceLabel: "OpenCode Go catalog",
            groupId: "opencode",
            groupLabel: "OpenCode",
            groupHint: "Zen + Go 目录共用 API Key",
          },
        }),
      ],
      capabilities: {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      },
      isModernModelRef: () => true,
    });
  },
};

export default opencodeGoPlugin;
