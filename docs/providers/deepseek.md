---
summary: "DeepSeek setup (auth + model selection)"
title: "DeepSeek"
read_when:
  - You want to use DeepSeek with OpenClaw
  - You need the API key env var or CLI auth choice
---

[DeepSeek](https://www.deepseek.com) provides powerful AI models with an OpenAI-compatible API.

| Property | Value                      |
| -------- | -------------------------- |
| Provider | `deepseek`                 |
| Auth     | `DEEPSEEK_API_KEY`         |
| API      | OpenAI-compatible          |
| Base URL | `https://api.deepseek.com` |

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice deepseek-api-key
    ```

    This will prompt for your API key and set `deepseek/deepseek-v4-flash` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider deepseek
    ```
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice deepseek-api-key \
      --deepseek-api-key "$DEEPSEEK_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If the Gateway runs as a daemon (launchd/systemd), make sure `DEEPSEEK_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

| Model ref                    | Name                       | Input | Context   | Max output | Notes                                                              |
| ---------------------------- | -------------------------- | ----- | --------- | ---------- | ------------------------------------------------------------------ |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash          | text  | 1,000,000 | 384,000    | Default model; supports DeepSeek's non-thinking and thinking modes |
| `deepseek/deepseek-v4-pro`   | DeepSeek V4 Pro            | text  | 1,000,000 | 384,000    | Supports DeepSeek's non-thinking and thinking modes                |
| `deepseek/deepseek-chat`     | DeepSeek Chat (legacy)     | text  | 1,000,000 | 384,000    | Compatibility alias for `deepseek-v4-flash` non-thinking mode      |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner (legacy) | text  | 1,000,000 | 65,536     | Compatibility alias for `deepseek-v4-flash` thinking mode          |

<Tip>
`deepseek-chat` and `deepseek-reasoner` are kept for compatibility and DeepSeek plans to deprecate both model names on 2026-07-24.
</Tip>

## Config example

```json5
{
  env: { DEEPSEEK_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-v4-flash" },
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
