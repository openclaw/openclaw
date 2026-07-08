---
summary: "TokenLab setup (auth + model selection)"
title: "TokenLab"
read_when:
  - You want to use TokenLab with OpenClaw
  - You need the API key env var or CLI auth choice
---

[TokenLab](https://tokenlab.sh) provides a multi-provider AI API with
OpenAI-compatible chat and native endpoint formats.

| Property | Value                        |
| -------- | ---------------------------- |
| Provider | `tokenlab`                   |
| Auth     | `TOKENLAB_API_KEY`           |
| API      | OpenAI-compatible            |
| Base URL | `https://api.tokenlab.sh/v1` |

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/tokenlab-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key in TokenLab at [tokenlab.sh](https://tokenlab.sh).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice tokenlab-api-key
    ```

    Prompts for your API key and sets `tokenlab/gpt-5.5` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider tokenlab
    ```

    To inspect the plugin's static catalog without a running Gateway:

    ```bash
    openclaw models list --all --provider tokenlab
    ```

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice tokenlab-api-key \
      --tokenlab-api-key "$TOKENLAB_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If Gateway runs as a daemon (launchd/systemd), make sure `TOKENLAB_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Endpoint formats

OpenClaw executes TokenLab models through the OpenAI-compatible chat route at
`https://api.tokenlab.sh/v1`.

TokenLab also exposes native endpoint formats for clients that support them:

- OpenAI Responses: `https://api.tokenlab.sh/v1/responses`
- Anthropic Messages: `https://api.tokenlab.sh` as the Anthropic SDK base URL
- Gemini generateContent: `https://api.tokenlab.sh/v1beta/models/{model}:generateContent`

Use these native formats outside OpenClaw when you need provider-specific
behavior such as Claude extended thinking or Gemini-native request bodies.

## Built-in catalog

| Model ref                           | Name                     | Input       | Context   | Max output | Notes                     |
| ----------------------------------- | ------------------------ | ----------- | --------- | ---------- | ------------------------- |
| `tokenlab/gpt-5.5`                  | GPT-5.5                  | text, image | 1,000,000 | 128,000    | Default model; reasoning  |
| `tokenlab/gpt-5.5-pro`              | GPT-5.5 Pro              | text, image | 1,050,000 | 128,000    | Stronger GPT path         |
| `tokenlab/gpt-5.4`                  | GPT-5.4                  | text, image | 400,000   | 128,000    | Reasoning                 |
| `tokenlab/gpt-5.4-mini`             | GPT-5.4 Mini             | text, image | 400,000   | 128,000    | Lower-cost GPT path       |
| `tokenlab/claude-sonnet-5`          | Claude Sonnet 5          | text, image | 1,000,000 | 128,000    | Claude family default     |
| `tokenlab/claude-opus-4-8`          | Claude Opus 4.8          | text, image | 1,000,000 | 128,000    | Strong Claude path        |
| `tokenlab/claude-fable-5`           | Claude Fable 5           | text, image | 1,000,000 | 128,000    | Creative Claude path      |
| `tokenlab/gemini-3.5-flash`         | Gemini 3.5 Flash         | text, image | 1,048,576 | 65,536     | Gemini flash path         |
| `tokenlab/gemini-3.1-flash-lite`    | Gemini 3.1 Flash Lite    | text, image | 1,048,576 | 65,536     | Low-cost Gemini path      |
| `tokenlab/grok-4.3`                 | Grok 4.3                 | text, image | 1,000,000 | 131,072    | Reasoning                 |
| `tokenlab/grok-4-fast`              | Grok 4 Fast              | text, image | 2,000,000 | 16,384     | Fast Grok path            |
| `tokenlab/deepseek-v4-pro`          | DeepSeek V4 Pro          | text        | 1,000,000 | 384,000    | DeepSeek pro path         |
| `tokenlab/deepseek-v4-flash`        | DeepSeek V4 Flash        | text        | 1,000,000 | 384,000    | DeepSeek fast path        |
| `tokenlab/glm-5.2`                  | GLM-5.2                  | text        | 1,000,000 | 128,000    | Tools disabled in catalog |
| `tokenlab/qwen3.7-max`              | Qwen3.7 Max              | text        | 991,808   | 65,536     | Tools disabled in catalog |
| `tokenlab/kimi-k2.7-code`           | Kimi K2.7 Code           | text, image | 262,144   | 131,072    | Coding model              |
| `tokenlab/kimi-k2.7-code-highspeed` | Kimi K2.7 Code Highspeed | text, image | 262,144   | 131,072    | Faster Kimi coding path   |
| `tokenlab/minimax-m3`               | MiniMax M3               | text        | 1,048,576 | 524,288    | Long-context path         |

## Config example

```json5
{
  env: { TOKENLAB_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "tokenlab/gpt-5.5" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
