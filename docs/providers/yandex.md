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
- Auth: `YANDEX_API_KEY`
- API: OpenAI-compatible

## Quick start

Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice yandex-api-key
```

This will prompt for your API key and set `yandex/yandexgpt/latest` as the default model.

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice yandex-api-key \
  --yandex-api-key "$YANDEX_API_KEY" \
  --skip-health \
  --accept-risk
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `YANDEX_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Available models

| Model ID               | Name             | Type    | Context |
| ----------------------- | ---------------- | ------- | ------- |
| `yandexgpt/latest`      | YandexGPT Pro    | General | 32K     |
| `yandexgpt/rc`          | YandexGPT Pro RC | General | 32K     |
| `yandexgpt-lite/latest` | YandexGPT Lite   | General | 32K     |

- **yandexgpt/latest** is the current stable YandexGPT Pro model.
- **yandexgpt/rc** is the release candidate of the next YandexGPT Pro version.
- **yandexgpt-lite/latest** is a faster, lower-cost model suitable for simple tasks and high throughput.

Get your API key at [Yandex AI Studio](https://aistudio.yandex.ru/).
