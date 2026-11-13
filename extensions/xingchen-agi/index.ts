import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";

export default defineSingleProviderPluginEntry({
  id: "xingchen-agi",
  name: "XingChen-AGI",
  description:
    "XingChen-AGI provider for Xing4.1-Preview from China Telecom AI Technology Co., Ltd.",
  provider: {
    label: "XingChen-AGI",
    docsPath: "/providers/xingchen-agi",
    auth: [
      {
        methodId: "api-key",
        label: "XingChen-AGI API key",
        hint: "API key from your China Telecom AI MaaS dashboard",
        optionKey: "xingchenApiKey",
        flagName: "--xingchen-api-key",
        envVar: "XINGCHEN_API_KEY",
        promptMessage: "Enter your XingChen-AGI API key",
        defaultModel: "xingchen-agi/xing4.1-preview",
      },
    ],
    catalog: {
      buildProvider: () => ({
        api: "openai-completions",
        baseUrl: "https://api-maas.teleai.com.cn/v1",
        models: [
          {
            id: "xing4.1-preview",
            name: "Xing4.1-Preview",
            reasoning: true,
            input: ["text"],
            output: ["text"],
            // Official USD pricing (released 2026-11-12), USD per 1M tokens.
            // Off-peak (standard): input $0.11 / cache read $0.0022 / output $0.45
            // Peak: $0.22 / $0.0045 / $0.90 (peak = 2x off-peak)
            // Peak window (US Eastern): Mon-Fri 00:00-11:00; off-peak otherwise + weekend.
            // Single-value cost fields hold the off-peak (standard) tier.
            cost: {
              input: 0.11,
              output: 0.45,
              cacheRead: 0.0022,
              cacheWrite: 0,
            },
            contextWindow: 1000000,
            maxTokens: 192000,
          },
        ],
      }),
    },
  },
});