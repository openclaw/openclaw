---
summary: "Novita setup (auth + dynamic model discovery)"
read_when:
  - You want to use Novita with OpenClaw
  - You need Novita auth and default model setup
  - You want to understand dynamic model discovery for Novita
title: "Novita AI"
---

# Novita AI

Novita provides an OpenAI-compatible API endpoint and a large model catalog.
OpenClaw supports Novita as provider `novita`.

- Provider: `novita`
- Auth: `NOVITA_API_KEY`
- Base URL: `https://api.novita.ai/openai`
- API mode: `openai-completions`
- Default model: `novita/moonshotai/kimi-k2.5`

## Quick start

1. Run onboarding and set your key:

```bash
openclaw onboard --auth-choice novita-api-key
```

2. Confirm or set your model:

```bash
openclaw models set novita/moonshotai/kimi-k2.5
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice novita-api-key \
  --novita-api-key "$NOVITA_API_KEY"
```

This sets `novita/moonshotai/kimi-k2.5` as the default model.

## Dynamic model discovery

When Novita auth is available, OpenClaw discovers models from:

`GET https://api.novita.ai/openai/v1/models`

- Successful discovery uses the live model list.
- If discovery fails, OpenClaw falls back to a built-in static model catalog.
- Discovery results are cached in-process for a short window.

Novita currently exposes a very large model catalog (200+ models). In OpenClaw,
use `openclaw models list --all` to browse the discovered `novita/*` models.

## Popular model examples

Three commonly used Novita models:

- `novita/moonshotai/kimi-k2.5`
- `novita/zai-org/glm-4.7`
- `novita/qwen/qwen3-coder-next`

Set one as default:

```bash
openclaw models set novita/moonshotai/kimi-k2.5
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), ensure `NOVITA_API_KEY`
is available to that process (for example, in your service environment).

## References

- API key management: [https://novita.ai/settings/key-management](https://novita.ai/settings/key-management)
- Model catalog: [https://novita.ai/models](https://novita.ai/models)
- API reference: [https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion](https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion)
