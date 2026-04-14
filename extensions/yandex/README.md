# Yandex Provider

[YandexGPT](https://yandex.cloud/en/services/yandexgpt) models via
[Yandex AI Studio](https://aistudio.yandex.ru/) OpenAI-compatible API.

## Setup

Two values are required:

1. **API key** from [Yandex AI Studio](https://aistudio.yandex.ru/)
2. **Folder ID** from [Yandex Cloud console](https://console.yandex.cloud/) — used to build model URIs in the form `gpt://<folder_ID>/<model_id>` and sent as the `OpenAI-Project` header
   ([TextGeneration API docs](https://yandex.cloud/en/docs/ai-studio/text-generation/api-ref/TextGeneration/completion))

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

| Model ID                | Name             | Context Window |
| ----------------------- | ---------------- | -------------- |
| `aliceai-llm`           | Alice AI LLM     | 32 768         |
| `yandexgpt/latest`      | YandexGPT Pro    | 32 768         |
| `yandexgpt/rc`          | YandexGPT Pro RC | 32 768         |
| `yandexgpt-lite/latest` | YandexGPT Lite   | 32 768         |

Use as `yandex/<model-id>`, e.g. `yandex/yandexgpt/latest`.

Model URIs sent on the wire: `gpt://<folder_ID>/yandexgpt/latest`, etc.
