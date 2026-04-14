---
summary: "Yandex AI Studio setup (auth + model selection)"
read_when:
  - You want to use YandexGPT with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Yandex

[YandexGPT](https://yandex.cloud/en/services/yandexgpt) models via
[Yandex AI Studio](https://aistudio.yandex.ru/) OpenAI-compatible API.

- Provider: `yandex`
- Auth: `YANDEX_API_KEY` + `YANDEX_FOLDER_ID`
- API: OpenAI-compatible (`https://llm.api.cloud.yandex.net/v1`)

## Prerequisites

You need two values from Yandex Cloud:

1. **API key** — create one at [Yandex AI Studio](https://aistudio.yandex.ru/)
2. **Folder ID** — found in your [Yandex Cloud console](https://console.yandex.cloud/). Required because model URIs are folder-scoped: `gpt://<folder_ID>/yandexgpt/latest`
   ([see TextGeneration API docs](https://yandex.cloud/en/docs/ai-studio/text-generation/api-ref/TextGeneration/completion))

The folder ID is sent as the `OpenAI-Project` header on every request.

## Quick start

```bash
openclaw onboard --auth-choice yandex-api-key
```

This prompts for both the API key and the folder ID in one step, then sets
`yandex/yandexgpt/latest` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice yandex-api-key \
  --yandex-api-key "$YANDEX_API_KEY" \
  --yandex-folder-id "$YANDEX_FOLDER_ID" \
  --skip-health \
  --accept-risk
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure both `YANDEX_API_KEY`
and `YANDEX_FOLDER_ID` are available to that process (e.g. in `~/.openclaw/.env`
or via `env.shellEnv`).

## Available models

| Model ID                | Name             | Context |
| ----------------------- | ---------------- | ------- |
| `aliceai-llm`           | Alice AI LLM     | 32K     |
| `yandexgpt/latest`      | YandexGPT Pro    | 32K     |
| `yandexgpt/rc`          | YandexGPT Pro RC | 32K     |
| `yandexgpt-lite/latest` | YandexGPT Lite   | 32K     |

Model URIs on the wire: `gpt://<folder_ID>/yandexgpt/latest`, etc.
In OpenClaw config use `yandex/yandexgpt/latest`.

Get your API key and folder ID at [Yandex AI Studio](https://aistudio.yandex.ru/).
