---
summary: "Clawpane setup (smart LLM router)"
read_when:
  - You want to use Clawpane with OpenClaw
  - You need the API key env var or CLI auth choice for Clawpane
---

# Clawpane

[Clawpane](https://clawpane.co) is a smart LLM router that automatically selects the best model for each request based on cost, latency, quality, or a balanced combination of all three. It routes across 35+ models behind a single OpenAI-compatible API endpoint.

- Provider: `clawpane`
- Auth: `CLAWPANE_API_KEY`
- API: OpenAI-compatible
- Base URL: `https://clawpane.co/route`

## Quick start

1. Get your API key from [https://clawpane.co/dashboard](https://clawpane.co/dashboard).
2. Authenticate with OpenClaw:

```bash
openclaw onboard --auth-choice clawpane-api-key
```

This sets `clawpane/auto` as the default model (balanced routing).

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice clawpane-api-key \
  --clawpane-api-key "$CLAWPANE_API_KEY"
```

## Available models

Clawpane exposes four routing presets as model IDs:

| Model ID           | Strategy                              |
| ------------------ | ------------------------------------- |
| `clawpane/auto`    | Balanced — cost, latency, and quality |
| `clawpane/fast`    | Latency-first — lowest response time  |
| `clawpane/economy` | Cost-first — most affordable routing  |
| `clawpane/quality` | Quality-first — best output quality   |

Set the active preset as your default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "clawpane/auto" },
    },
  },
}
```

## Environment variable

If the Gateway runs as a daemon (launchd/systemd), make sure `CLAWPANE_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Manual configuration

You can configure the provider directly in `~/.openclaw/config.json`:

```json5
{
  models: {
    providers: {
      clawpane: {
        baseUrl: "https://clawpane.co/route",
        apiKey: "your-clawpane-api-key",
        api: "openai-completions",
        models: [
          { id: "auto", name: "Clawpane Auto (balanced)" },
          { id: "fast", name: "Clawpane Fast (latency-first)" },
          { id: "economy", name: "Clawpane Economy (cost-first)" },
          { id: "quality", name: "Clawpane Quality (quality-first)" },
        ],
      },
    },
  },
}
```
