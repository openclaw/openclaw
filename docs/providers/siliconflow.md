---
title: "SiliconFlow"
summary: "SiliconFlow setup (auth + model selection)"
read_when:
  - You want to use SiliconFlow with OpenClaw
  - You need the API key env var or CLI auth choice
---

# SiliconFlow

[SiliconFlow](https://siliconflow.cn) provides access to a wide range of popular open-source models through an OpenAI-compatible API.

- Provider: `siliconflow`
- Auth: `SILICONFLOW_API_KEY`
- API: OpenAI-compatible
- Base URL: `https://api.siliconflow.cn/v1`

## Quick start

1. Get an API key from the [SiliconFlow platform dashboard](https://siliconflow.cn).

2. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice siliconflow-api-key
```

3. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "siliconflow/Qwen/Qwen2.5-7B-Instruct" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice siliconflow-api-key \
  --siliconflow-api-key "$SILICONFLOW_API_KEY"
```

This will set `siliconflow/Qwen/Qwen2.5-7B-Instruct` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `SILICONFLOW_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Built-in catalog

OpenClaw currently ships this bundled SiliconFlow catalog:

| Model ref                               | Name                 | Input | Context | Cost (in/out per 1M) | Notes                             |
| --------------------------------------- | -------------------- | ----- | ------- | -------------------- | --------------------------------- |
| `siliconflow/Qwen/Qwen2.5-7B-Instruct`  | Qwen2.5-7B-Instruct  | text  | 128K    | $0.10 / $0.10        | Default model; fast and efficient |
| `siliconflow/Qwen/Qwen2.5-72B-Instruct` | Qwen2.5-72B-Instruct | text  | 128K    | $0.10 / $0.10        | High-performance model            |
| `siliconflow/deepseek-ai/DeepSeek-V3`   | DeepSeek-V3          | text  | 128K    | $0.10 / $0.10        | General-purpose                   |
| `siliconflow/deepseek-ai/DeepSeek-R1`   | DeepSeek-R1          | text  | 128K    | $0.10 / $0.10        | Reasoning enabled                 |

The onboarding preset sets `siliconflow/Qwen/Qwen2.5-7B-Instruct` as the default model.

## Supported features

- Streaming
- Tool use / function calling
- Structured output (JSON mode and JSON schema)
- Extended thinking (DeepSeek-R1)

---

Note: This is a community-contributed integration, not an official SiliconFlow contribution.
