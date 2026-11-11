import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import { buildDashscopeVideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";

const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";

export default definePluginEntry({
  id: "alibaba",
  name: "Alibaba Model Studio Plugin",
  description: "Bundled Alibaba Model Studio video provider plugin",
  register(api) {
    api.registerProvider({
      id: "alibaba",
      label: "Alibaba Model Studio",
      docsPath: "/providers/alibaba",
      envVars: ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "alibaba",
          methodId: "api-key",
          label: "Alibaba Model Studio API key",
          optionKey: "alibabaModelStudioApiKey",
          flagName: "--alibaba-model-studio-api-key",
          envVar: "MODELSTUDIO_API_KEY",
          promptMessage: "Enter Alibaba Model Studio API key",
          wizard: {
            choiceId: "alibaba-model-studio-api-key",
            choiceLabel: "Alibaba Model Studio API key",
            groupId: "alibaba",
            groupLabel: "Alibaba Model Studio",
            groupHint: "DashScope / Model Studio API key",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerVideoGenerationProvider(
      buildDashscopeVideoGenerationProvider({
        providerId: "alibaba",
        label: "Alibaba Model Studio",
        taskLabel: "Alibaba Wan",
        defaultBaseUrl: DEFAULT_ALIBABA_VIDEO_BASE_URL,
        credentialPolicy: {
          // Coding/Token Plan keys share Alibaba's env aliases but cannot authenticate Wan requests.
          acceptsApiKey: (apiKey) => !apiKey.trim().startsWith("sk-sp-"),
          acceptsBaseUrl: (baseUrl) => {
            const hostname = URL.parse(baseUrl ?? DEFAULT_ALIBABA_VIDEO_BASE_URL)?.hostname ?? "";
            return !/^(?:coding(?:-intl)?\.dashscope|token-plan\..+\.maas)\.aliyuncs\.com\.?$/iu.test(
              hostname,
            );
          },
          unsupportedMessage:
            "Alibaba Wan video generation requires a Standard DashScope endpoint and a same-region Standard API key; Coding Plan and Token Plan credentials are not supported.",
        },
      }),
    );
  },
});
