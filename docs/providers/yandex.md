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

You need two values from Yandex AI Studio:

1. **API key** — create one at [Yandex AI Studio → API keys](https://aistudio.yandex.ru/)
2. **Folder ID** — found in Yandex Cloud console under your cloud/folder. Required because Yandex AI Studio model URIs are folder-scoped: `gpt://<folder_ID>/<model_name>` ([docs](https://aistudio.yandex.ru/docs/en/ai-studio/concepts/generation/models.html))

## Quick start

```bash
openclaw onboard --auth-choice yandex-api-key
openclaw onboard --auth-choice yandex-folder-id
```

This sets `yandex/yandexgpt-5.1` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice yandex-api-key \
  --yandex-api-key "$YANDEX_API_KEY" \
  --auth-choice yandex-folder-id \
  --yandex-folder-id "$YANDEX_FOLDER_ID" \
  --skip-health \
  --accept-risk
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure both `YANDEX_API_KEY`
and `YANDEX_FOLDER_ID` are available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).

## Available models

| Model ID          | Name              | Context |
| ----------------- | ----------------- | ------- |
| `yandexgpt-5.1`   | YandexGPT Pro 5.1 | 32K     |
| `yandexgpt-5-pro` | YandexGPT Pro 5   | 32K     |
| `yandexgpt-5-lite`| YandexGPT Lite 5  | 32K     |

All models are addressed as `gpt://<folder_ID>/<model_name>` on the wire.
In OpenClaw config use `yandex/<model_name>`, e.g. `yandex/yandexgpt-5.1`.

Get your API key and folder ID at [Yandex AI Studio](https://aistudio.yandex.ru/).
