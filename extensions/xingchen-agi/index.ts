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
            // Pricing (USD per 1M tokens), public price card:
            // https://xingchen-agi.github.io/pricing/
            // List: input $0.225 / cache read $0.01125 / output $0.90.
            // Limited-time offer (20% of list, through 2026-12-20):
            // input $0.045 / cache read $0.00225 / output $0.18.
            // Single-value cost fields hold the offer price currently in effect;
            // switch them to the list prices when the offer ends on 2026-12-20.
            cost: {
              input: 0.045,
              output: 0.18,
              cacheRead: 0.00225,
              cacheWrite: 0,
            },
            contextWindow: 1024000,
            maxTokens: 128000,
          },
        ],
      }),
    },
  },
});
