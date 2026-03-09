---
summary: "Use AIPing OpenAI-compatible models in OpenClaw"
read_when:
  - You want to use AIPing as your LLM provider
  - You need OpenAI-compatible base URL + API key setup
title: "AIPing"
---

# AIPing

AIPing provides an OpenAI-compatible API endpoint at `https://aiping.cn/api/v1`.
You can configure it in OpenClaw like other API-key providers (for example
OpenAI or Moonshot).
Get your API key from [AIPing API Key page](https://aiping.cn/user/apikey).

## CLI setup

```bash
openclaw onboard --auth-choice aiping-api-key

# non-interactive
openclaw onboard --auth-choice aiping-api-key --aiping-api-key "$AIPING_API_KEY"
```

When you use the interactive `openclaw onboard` / `openclaw configure` flow,
OpenClaw now provides AIPing routing presets directly in the wizard:

- Balanced (default)
- Low latency (`:latency`)
- High throughput (`:throughput`)
- Lowest input price (`:input_price`)

## Config snippet

```json5
{
  env: { AIPING_API_KEY: "your-aiping-key" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "aiping/DeepSeek-V3.2" } } },
  models: {
    mode: "merge",
    providers: {
      aiping: {
        baseUrl: "https://aiping.cn/api/v1",
        apiKey: "${AIPING_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "DeepSeek-V3.2",
            name: "DeepSeek V3.2",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notes

- Provider env var: `AIPING_API_KEY`
- Default model ref used by onboarding: `aiping/DeepSeek-V3.2`
- You can switch to router mode with model `aiping/Auto` if your account enables it.

## AIPing router-param (provider sorting/filtering)

AIPing supports router sorting/filtering in the **model string** using colon syntax:

`model:sort:param1,param2,...`

OpenClaw passes model IDs through as-is for the AIPing provider, so you can use
this directly in model refs.

Examples (from AIPing docs):

- `DeepSeek-R1:latency`
- `DeepSeek-R1:throughput:latency<500,input_price<1.0`
- `MiniMax-M2::only=硅基流动,阿里云百炼`
- `MiniMax-M2:latency:ignore=移动云,nofallback`

In OpenClaw:

```bash
openclaw models set "aiping/DeepSeek-R1:latency"
```

Or pin in config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "aiping/DeepSeek-R1:latency:latency<500,input_price<1.0" },
      models: {
        "aiping/DeepSeek-R1:latency:latency<500,input_price<1.0": { alias: "AIPing Fast" },
      },
    },
  },
}
```

Reference:

- [AIPing router-param docs](https://aiping.cn/docs/Features/router-param)
