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
- Default model ref: `vivgrid/auto`
- Default API mode: `openai-completions`

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

This sets `agents.defaults.model.primary` to `vivgrid/auto`.

## API mode

OpenClaw uses `openai-completions` for Vivgrid by default. If you need Responses API routing, set `api` to `openai-responses`:

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
