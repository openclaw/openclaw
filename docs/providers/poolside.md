---
summary: "Poolside setup for the Laguna model family"
title: "Poolside"
read_when:
  - You want to run Poolside's Laguna models in OpenClaw
  - You want one OpenAI-compatible API for the Laguna model family
---

[Poolside](https://poolside.ai) serves its Laguna model family over a hosted, OpenAI-compatible API. The official external plugin ships a static catalog of the Laguna models, with tool calling and reasoning enabled.

| Property        | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Provider id     | `poolside`                                                |
| Plugin          | official external package (`@openclaw/poolside-provider`) |
| Auth env var    | `POOLSIDE_API_KEY`                                        |
| Onboarding flag | `--auth-choice poolside-api-key`                          |
| Direct CLI flag | `--poolside-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                  |
| Base URL        | `https://inference.poolside.ai/v1`                        |
| Default model   | `poolside/laguna-s-2.1`                                   |

## Install plugin

```bash
openclaw plugins install @openclaw/poolside-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get a Poolside API key">
    Create an API key from your Poolside account and export it as `POOLSIDE_API_KEY`.
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice poolside-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice poolside-api-key \
  --poolside-api-key "$POOLSIDE_API_KEY"
```

```bash Env only
export POOLSIDE_API_KEY=...
```

    </CodeGroup>

  </Step>
  <Step title="Verify the catalog">
    ```bash
    openclaw models list --provider poolside
    ```

  </Step>
</Steps>

## Models

Every Laguna model supports text input, tool calling, and reasoning, and returns up to 32k output tokens:

| Model ref                     | Context | Max output |
| ----------------------------- | ------: | ---------: |
| `poolside/laguna-s-2.1`       |    262k |        32k |
| `poolside/laguna-s-2.1:fast`  |  1.048M |        32k |
| `poolside/laguna-xs-2.1`      |    262k |        32k |
| `poolside/laguna-xs-2.1:fast` |    262k |        32k |
| `poolside/laguna-m.1`         |    262k |        32k |
| `poolside/laguna-m.1:fast`    |    262k |        32k |

```json5
{
  agents: {
    defaults: {
      model: { primary: "poolside/laguna-s-2.1" },
    },
  },
}
```

Use `/model poolside/laguna-s-2.1` to switch an existing chat.

## Sampling

Poolside's endpoints accept `temperature` only. They ignore `top_p`, `top_k`, `min_p`, and the presence/frequency penalties, and their no-parameter default (untruncated temperature 1.0) produces malformed output. The plugin therefore defaults `temperature` to `0.7` when a request sets none, and drops the unsupported sampling fields before they reach the wire. Set your own `temperature` in config to override the default; other sampling knobs have no effect.

Laguna reasoning is always on and there is no `reasoning_effort` control, so OpenClaw streams `reasoning_content` without sending a reasoning-effort field.

## Manual config

Most setups only need the API key. To pin the provider explicitly:

```json5
{
  env: { POOLSIDE_API_KEY: "..." },
  agents: {
    defaults: {
      model: { primary: "poolside/laguna-s-2.1" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      poolside: {
        baseUrl: "https://inference.poolside.ai/v1",
        apiKey: "${POOLSIDE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "laguna-s-2.1",
            name: "Laguna S 2.1",
            reasoning: true,
            input: ["text"],
            contextWindow: 262144,
            maxTokens: 32768,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsUsageInStreaming: true,
              supportsStrictMode: false,
              supportsTools: true,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `POOLSIDE_API_KEY` is available to that process. A key exported only in an interactive shell is not visible to an already-running managed service.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Models CLI" href="/cli/models" icon="terminal">
    List, inspect, and select models.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles and model-selection troubleshooting.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    How OpenClaw surfaces reasoning output.
  </Card>
</CardGroup>
