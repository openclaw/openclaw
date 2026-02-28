---
summary: "Use Vivgrid as an OpenAI-compatible provider in OpenClaw"
read_when:
  - You want to use Vivgrid with OpenClaw
  - You need Vivgrid API key or non-interactive setup flags
title: "Vivgrid"
---

# Vivgrid

Vivgrid provides OpenAI-compatible APIs, including the Responses API.
OpenClaw includes Vivgrid as a built-in provider.

- Provider: `vivgrid`
- Auth env var: `VIVGRID_API_KEY`
- Base URL: `https://api.vivgrid.com/v1`
- Default model ref: `vivgrid/gpt-5-mini`
- Default API mode: `openai-completions`

Built-in Vivgrid fallback catalog keeps only `vivgrid/gpt-5-mini` for maximum compatibility.
Responses-only or Claude models are populated from dynamic discovery and mapped with model-level `api`.

## Quick start

```bash
openclaw onboard --auth-choice vivgrid-api-key
```

## Non-interactive setup

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice vivgrid-api-key \
  --vivgrid-api-key "$VIVGRID_API_KEY"
```

This sets `agents.defaults.model.primary` to `vivgrid/gpt-5-mini`.

## API mode

OpenClaw uses provider-level default `openai-completions`, and also supports model-level API override.
Use this pattern when some models (for example codex-style models) require Responses API while others still use Completions API.

## Dynamic model discovery

OpenClaw attempts to discover Vivgrid models dynamically from `GET /v1/models` when Vivgrid is enabled.

- On success, discovered models are used as the provider catalog.
- On failure or empty result, OpenClaw falls back to built-in default (`gpt-5-mini`).
- Vivgrid `/models` currently returns model ids only in most environments.
- OpenClaw maps model-level API primarily by model id naming rules:
  - ids containing `codex` -> `openai-responses`
  - ids containing `claude` -> `anthropic-messages`
  - others -> provider default (`openai-completions`)
- If Vivgrid later returns capability metadata, OpenClaw also uses it as an additional signal.

```json5
{
  models: {
    providers: {
      vivgrid: {
        api: "openai-completions",
        baseUrl: "https://api.vivgrid.com/v1",
        models: [
          {
            id: "gpt-5-mini",
            name: "Vivgrid GPT-5 mini",
            reasoning: true,
            input: ["text", "image"],
          },
          { id: "gpt-codex", name: "gpt-codex", api: "openai-responses", reasoning: true },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "vivgrid/gpt-codex",
      },
    },
  },
}
```

If all your Vivgrid models should use Responses API, set provider-level `api` directly:

```json5
{
  models: {
    providers: {
      vivgrid: {
        api: "openai-responses",
        baseUrl: "https://api.vivgrid.com/v1",
      },
    },
  },
}
```

## Related documentation

- [CLI Onboarding Reference](/start/wizard-cli-reference)
- [Model providers](/concepts/model-providers)
