---
title: "Groq"
summary: "Groq setup (auth + model selection)"
read_when:
  - You want to use Groq with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Groq

[Groq](https://groq.com) provides ultra-fast inference on open-source models
(Llama, Gemma, Mistral, and more) using custom LPU hardware. OpenClaw connects
to Groq through its OpenAI-compatible API.

- Provider: `groq`
- Auth: `GROQ_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Get an API key from [console.groq.com/keys](https://console.groq.com/keys).

2. Set the API key:

```bash
export GROQ_API_KEY="gsk_..."
```

3. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## Config file example

```json5
{
  env: { GROQ_API_KEY: "gsk_..." },
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## Audio transcription

Groq also provides fast Whisper-based audio transcription. When configured as a
media-understanding provider, OpenClaw uses Groq's `whisper-large-v3-turbo`
model to transcribe voice messages through the shared `tools.media.audio`
surface.

```json5
{
  tools: {
    media: {
      audio: {
        models: [{ provider: "groq" }],
      },
    },
  },
}
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `GROQ_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Audio notes

- Shared config path: `tools.media.audio`
- Default Groq audio base URL: `https://api.groq.com/openai/v1`
- Default Groq audio model: `whisper-large-v3-turbo`
- Groq audio transcription uses the OpenAI-compatible `/audio/transcriptions`
  path

## Available models

Groq's model catalog changes frequently. Run `openclaw models list | grep groq`
to see currently available models, or check
[console.groq.com/docs/models](https://console.groq.com/docs/models).

Popular choices include:

- **Llama 3.3 70B Versatile** - general-purpose, large context
- **Llama 3.1 8B Instant** - fast, lightweight
- **Gemma 2 9B** - compact, efficient
- **Mixtral 8x7B** - MoE architecture, strong reasoning

## Links

- [Groq Console](https://console.groq.com)
- [API Documentation](https://console.groq.com/docs)
- [Model List](https://console.groq.com/docs/models)
- [Pricing](https://groq.com/pricing)
