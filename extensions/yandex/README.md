# Yandex Provider

[YandexGPT](https://yandex.cloud/en/services/yandexgpt) models via
[Yandex AI Studio](https://aistudio.yandex.ru/) OpenAI-compatible API.

## Setup

Two values are required:

1. **API key** from [Yandex AI Studio](https://aistudio.yandex.ru/)
2. **Folder ID** from Yandex Cloud — used to build model URIs in the form `gpt://<folder_ID>/<model_name>` ([see docs](https://aistudio.yandex.ru/docs/en/ai-studio/concepts/generation/models.html))

```bash
openclaw onboard --auth-choice yandex-api-key
openclaw onboard --auth-choice yandex-folder-id
```

Or set environment variables directly:

```bash
export YANDEX_API_KEY=<your_api_key>
export YANDEX_FOLDER_ID=<your_folder_id>
```

## Models

| Model ID           | Name              | Context Window |
| ------------------ | ----------------- | -------------- |
| `yandexgpt-5.1`    | YandexGPT Pro 5.1 | 32 768         |
| `yandexgpt-5-pro`  | YandexGPT Pro 5   | 32 768         |
| `yandexgpt-5-lite` | YandexGPT Lite 5  | 32 768         |

Use as `yandex/<model-id>`, for example `yandex/yandexgpt-5.1`.

Model URIs sent on the wire: `gpt://<folder_ID>/yandexgpt-5.1`, etc.
