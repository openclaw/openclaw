---
title: "Chutes"
summary: "Chutes setup (OAuth or API key, model discovery, aliases)"
read_when:
  - You want to use Chutes with OpenClaw
  - You need the OAuth or API key setup path
  - You want the default model, aliases, or discovery behavior
---

# Chutes

[Chutes](https://chutes.ai) exposes open-source model catalogs through an
OpenAI-compatible API. OpenClaw supports both browser OAuth and direct API-key
auth for the bundled `chutes` provider.

- Provider: `chutes`
- API: OpenAI-compatible
- Base URL: `https://llm.chutes.ai/v1`
- Auth:
  - OAuth via `openclaw onboard --auth-choice chutes`
  - API key via `openclaw onboard --auth-choice chutes-api-key`
  - Runtime env vars: `CHUTES_API_KEY`, `CHUTES_OAUTH_TOKEN`

## Quick start

### OAuth

```bash
openclaw onboard --auth-choice chutes
```

OpenClaw launches the browser flow locally, or shows a URL + redirect-paste
flow on remote/headless hosts. OAuth tokens auto-refresh through OpenClaw auth
profiles.

Optional OAuth overrides:

- `CHUTES_CLIENT_ID`
- `CHUTES_CLIENT_SECRET`
- `CHUTES_OAUTH_REDIRECT_URI`
- `CHUTES_OAUTH_SCOPES`

### API key

```bash
openclaw onboard --auth-choice chutes-api-key
```

Get your key at
[chutes.ai/settings/api-keys](https://chutes.ai/settings/api-keys).

Both auth paths register the bundled Chutes catalog and set the default model
to `chutes/zai-org/GLM-4.7-TEE`.

## Discovery behavior

When Chutes auth is available, OpenClaw queries the Chutes catalog with that
credential and uses the discovered models. If discovery fails, OpenClaw falls
back to a bundled static catalog so onboarding and startup still work.

## Default aliases

OpenClaw also registers three convenience aliases for the bundled Chutes
catalog:

- `chutes-fast` -> `chutes/zai-org/GLM-4.7-FP8`
- `chutes-pro` -> `chutes/deepseek-ai/DeepSeek-V3.2-TEE`
- `chutes-vision` -> `chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506`

## Built-in starter catalog

The bundled fallback catalog includes current Chutes refs such as:

- `chutes/zai-org/GLM-4.7-TEE`
- `chutes/zai-org/GLM-5-TEE`
- `chutes/deepseek-ai/DeepSeek-V3.2-TEE`
- `chutes/deepseek-ai/DeepSeek-R1-0528-TEE`
- `chutes/moonshotai/Kimi-K2.5-TEE`
- `chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506`
- `chutes/Qwen/Qwen3-Coder-Next-TEE`
- `chutes/openai/gpt-oss-120b-TEE`

## Config example

```json5
{
  agents: {
    defaults: {
      model: { primary: "chutes/zai-org/GLM-4.7-TEE" },
      models: {
        "chutes/zai-org/GLM-4.7-TEE": { alias: "Chutes GLM 4.7" },
        "chutes/deepseek-ai/DeepSeek-V3.2-TEE": { alias: "Chutes DeepSeek V3.2" },
      },
    },
  },
}
```

## Notes

- OAuth help and redirect-app requirements: [Chutes OAuth docs](https://chutes.ai/docs/sign-in-with-chutes/overview)
- API-key and OAuth discovery both use the same `chutes` provider id.
- Chutes models are registered as `chutes/<model-id>`.
