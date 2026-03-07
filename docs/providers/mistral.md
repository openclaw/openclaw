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
