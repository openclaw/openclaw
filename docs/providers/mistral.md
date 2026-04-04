---
summary: "Use Mistral models and Voxtral transcription with OpenClaw"
read_when:
  - You want to use Mistral models in OpenClaw
  - You need Mistral API key onboarding and model refs
title: "Mistral"
---

# Mistral

OpenClaw supports Mistral for both text/image model routing (`mistral/...`) and
audio transcription via Voxtral in media understanding.
Mistral can also be used for memory embeddings (`memorySearch.provider = "mistral"`).

## CLI setup

```bash
openclaw onboard --auth-choice mistral-api-key
# or non-interactive
openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
```

## Config snippet (LLM provider)

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
}
```

## Built-in LLM catalog

OpenClaw currently ships this bundled Mistral catalog:

| Model ref                        | Input       | Context | Max output | Notes                    |
| -------------------------------- | ----------- | ------- | ---------- | ------------------------ |
| `mistral/mistral-large-latest`   | text, image | 262,144 | 16,384     | Default model            |
| `mistral/mistral-medium-2508`    | text, image | 262,144 | 8,192      | Mistral Medium 3.1       |
| `mistral/mistral-small-latest`   | text, image | 128,000 | 16,384     | Smaller multimodal model |
| `mistral/pixtral-large-latest`   | text, image | 128,000 | 32,768     | Pixtral                  |
| `mistral/codestral-latest`       | text        | 256,000 | 4,096      | Coding                   |
| `mistral/devstral-medium-latest` | text        | 262,144 | 32,768     | Devstral 2               |
| `mistral/magistral-small`        | text        | 128,000 | 40,000     | Reasoning-enabled        |

## Config snippet (audio transcription with Voxtral)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

## Notes

- Mistral auth uses `MISTRAL_API_KEY`.
- Provider base URL defaults to `https://api.mistral.ai/v1`.
- Onboarding default model is `mistral/mistral-large-latest`.
- Media-understanding default audio model for Mistral is `voxtral-mini-latest`.
- Media transcription path uses `/v1/audio/transcriptions`.
- Memory embeddings path uses `/v1/embeddings` (default model: `mistral-embed`).
