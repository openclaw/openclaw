---
summary: "Use Nebius Token Factory as an OpenAI-compatible provider"
read_when:
  - You want to call Nebius Token Factory with OpenAI-compatible APIs
  - You need CLI steps to onboard Nebius Token Factory
title: "Nebius Token Factory"
---

# Nebius Token Factory

Nebius Token Factory exposes an OpenAI-compatible endpoint. OpenClaw can auto‑discover
models from the API and wire the provider without manual model lists.

## Quick start

1. Get your API key from Nebius Token Factory.
2. Run a non-interactive onboarding (API key only):

```bash
openclaw onboard \
  --auth-choice nebius-token-factory-api-key \
  --nebius-token-factory-api-key "$NEBIUS_TOKEN_FACTORY"
```

3. Or launch the interactive flow and pick **Nebius Token Factory**:

```bash
openclaw onboard
```

## Models and defaults

- Base URL: `https://api.tokenfactory.nebius.com/v1`
- Default model: `nebius-token-factory/zai-org/GLM-4.7-FP8`
- Models auto-populate from `GET /models`; OpenClaw falls back to the default
  if discovery fails.

## Configuration reference

You usually don't need a manual `models.providers` block, but you can pin it explicitly:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "nebius-token-factory": {
        api: "openai-completions",
        baseUrl: "https://api.tokenfactory.nebius.com/v1",
        apiKey: "${NEBIUS_TOKEN_FACTORY}",
      },
    },
  },
}
```

## Auth keys

- Env var: `NEBIUS_TOKEN_FACTORY` (preferred), `NEBIUS_API_KEY` (fallback)
- CLI flag: `--nebius-token-factory-api-key`

If the env var is set, onboarding and non-interactive flows auto-detect it.

## Troubleshooting

- **401 during discovery**: check the API key value and that the key has access to model listing.
- **No models returned**: OpenClaw will still register the provider with the default model; verify
  your account has model access if you expect more.
- To re-run discovery: `openclaw models list --provider nebius-token-factory`
