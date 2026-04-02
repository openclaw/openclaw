# Yandex Provider

[YandexGPT](https://yandex.cloud/en/services/yandexgpt) models via
[Yandex AI Studio](https://aistudio.yandex.ru/) OpenAI-compatible API.

## Setup

```bash
openclaw onboard --auth-choice yandex-api-key
```

Or set the `YANDEX_API_KEY` environment variable.

Get an API key from [Yandex AI Studio](https://aistudio.yandex.ru/).

## Models

| Model ID                | Name             | Context Window |
| ----------------------- | ---------------- | -------------- |
| `yandexgpt/latest`      | YandexGPT Pro    | 32 768         |
| `yandexgpt/rc`          | YandexGPT Pro RC | 32 768         |
| `yandexgpt-lite/latest` | YandexGPT Lite   | 32 768         |

Use as `yandex/<model-id>`, for example `yandex/yandexgpt/latest`.
