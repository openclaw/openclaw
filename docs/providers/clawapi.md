---
summary: "ClawAPI setup (auth + model selection)"
read_when:
  - You want to use ClawAPI with OpenClaw
  - You need the API key env var or CLI auth choice
title: "ClawAPI"
---

# ClawAPI

[ClawAPI](https://clawapi.org) is a crypto-native multi-model API gateway. One key, 8 models from 4 providers.

Build for OPC (One Person Company) — Every human being is a Chairman.

- Provider: `clawapi`
- Auth: `CLAWAPI_KEY`
- API: OpenAI-compatible
- Free 10M tokens for new accounts

## Quick start

1. Get your API key at [clawapi.org](https://clawapi.org)
2. Authenticate (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice clawapi-api-key
```

3. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "clawapi/gpt-5.4" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice clawapi-api-key \
  --clawapi-api-key "$CLAWAPI_KEY"
```

This will set `clawapi/gpt-5.4` as the default model.

## Environment variable

```bash
export CLAWAPI_KEY="sk-claw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

If the Gateway runs as a daemon (launchd/systemd), make sure `CLAWAPI_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

ClawAPI provides access to 8 models across 4 providers, each with a role name:

| Model ID                | Name                  | Role       | Reasoning | Context | Max Tokens | Cost (input/output per 1M) |
| ----------------------- | --------------------- | ---------- | --------- | ------- | ---------- | -------------------------- |
| `claude-opus-4-6`       | Claude Opus 4.6       | CEO        | Yes       | 1M      | 4,096      | $5.00 / $25.00             |
| `gpt-5.4`               | GPT-5.4               | CTO        | Yes       | 1.05M   | 128,000    | $2.50 / $15.00             |
| `claude-sonnet-4-6`     | Claude Sonnet 4.6     | CMO        | Yes       | 1M      | 4,096      | $3.00 / $15.00             |
| `gemini-3.1-pro`        | Gemini 3.1 Pro        | Researcher | Yes       | 1M      | 16,384     | $2.00 / $12.00             |
| `gpt-5-mini`            | GPT-5 Mini            | CFO        | Yes       | 400k    | 128,000    | $0.25 / $2.00              |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash-Lite | Secretary  | No        | 1M      | 32,768     | $0.25 / $1.50              |
| `gpt-oss-120b`          | GPT-OSS-120B          | Engineer   | No        | 128k    | 8,192      | $0.05 / $0.45              |
| `gpt-oss-20b`           | GPT-OSS-20B           | Intern     | No        | 128k    | 8,192      | $0.04 / $0.18              |

All models support standard chat completions and are OpenAI API compatible.

## Which model should I use

| Use Case                     | Recommended Model       | Why                                        |
| ---------------------------- | ----------------------- | ------------------------------------------ |
| **General default**          | `gpt-5.4`               | Best balance of capability and cost        |
| **Highest quality**          | `claude-opus-4-6`       | Strongest reasoning, largest context       |
| **Fast and cheap**           | `gpt-oss-20b`           | Lowest cost, good for simple tasks         |
| **Long context + reasoning** | `gemini-3.1-pro`        | 1M context with reasoning at moderate cost |
| **Budget reasoning**         | `gpt-5-mini`            | Reasoning capability at low cost           |
| **High throughput**          | `gemini-3.1-flash-lite` | 1M context, fast, no reasoning overhead    |

## Usage examples

```bash
# Use the default model (GPT-5.4)
openclaw agent --model clawapi/gpt-5.4 --message "Quick health check"

# Use Claude Opus via ClawAPI
openclaw agent --model clawapi/claude-opus-4-6 --message "Summarize this task"

# Use the cheapest model for simple tasks
openclaw agent --model clawapi/gpt-oss-20b --message "Format this list"
```

## Config file example

```json5
{
  env: { CLAWAPI_KEY: "sk-claw-..." },
  agents: { defaults: { model: { primary: "clawapi/gpt-5.4" } } },
  models: {
    mode: "merge",
    providers: {
      clawapi: {
        baseUrl: "https://clawapi.org/api/v1",
        apiKey: "${CLAWAPI_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4 (CTO)",
            reasoning: true,
            input: ["text"],
            cost: { input: 2.5, output: 15.0, cacheRead: 2.5, cacheWrite: 15.0 },
            contextWindow: 1050000,
            maxTokens: 128000,
          },
        ],
      },
    },
  },
}
```

## Troubleshooting

| Problem               | Fix                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Timeout with tools    | Must use `stream: true` when sending tool definitions. Without streaming, the gateway times out at 25s on complex requests |
| 400 with tool results | Tool call IDs must use snake_case `tool_call_id`, not camelCase `toolCallId`. ClawAPI follows OpenAI format strictly       |

## Links

- [ClawAPI](https://clawapi.org)
- [Feature Request](https://github.com/openclaw/openclaw/issues/47727)
