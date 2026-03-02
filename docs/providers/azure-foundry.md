---
summary: "Use Azure AI Foundry / Azure OpenAI models with OpenClaw"
read_when:
  - You want to use Azure AI Foundry models with OpenClaw
  - You need Azure OpenAI credential/endpoint setup for model calls
  - You want audio transcription or TTS via Azure
title: "Azure Foundry"
---

# Azure Foundry

OpenClaw can use **Azure AI Foundry** (formerly Azure OpenAI) models for chat,
audio transcription (STT), and text-to-speech (TTS). Auth uses a **Bearer token**
(API key) against the Azure inference endpoint.

## What OpenClaw supports

- Provider ID: `azure-foundry`
- API: `openai-completions` (OpenAI models) and `anthropic-messages` (Claude models)
- Auth: `Authorization: Bearer <key>` (chat) / `api-key` header (STT/TTS)
- Endpoint styles: native Azure AI Inference (`/models`), OpenAI-compatible (`/openai/v1`), and Anthropic (`/anthropic`)
- Automatic model discovery from the `/models` endpoint
- Built-in catalog: GPT-4o, GPT-4.1, o3-mini, o4-mini, DeepSeek-R1, Phi-4, Mistral Large, Llama 3.1 405B, Cohere Command R+, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Haiku 3.5

## Environment variables

OpenClaw accepts multiple env var names for each setting, checked in priority order:

| Setting     | Primary                     | Aliases                                                                  |
| ----------- | --------------------------- | ------------------------------------------------------------------------ |
| API key     | `AZURE_FOUNDRY_API_KEY`     | `AZURE_OPENAI_API_KEY`, `AZURE_INFERENCE_CREDENTIAL`, `AZURE_AI_API_KEY` |
| Endpoint    | `AZURE_FOUNDRY_ENDPOINT`    | `AZURE_OPENAI_ENDPOINT`, `AZURE_INFERENCE_ENDPOINT`, `AZURE_AI_ENDPOINT` |
| API version | `AZURE_FOUNDRY_API_VERSION` | `AZURE_OPENAI_API_VERSION`                                               |

If you already have `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` set (the standard Azure OpenAI env vars), OpenClaw will pick them up automatically.

## CLI setup

```bash
openclaw onboard --auth-choice azure-foundry-api-key
# or non-interactive
openclaw onboard --azure-foundry-api-key "$AZURE_OPENAI_API_KEY"
```

## Config snippet (LLM provider)

```json5
{
  agents: { defaults: { model: { primary: "azure-foundry/gpt-4o" } } },
}
```

If your endpoint is not the default (`https://models.inference.ai.azure.com`), set it explicitly:

```json5
{
  models: {
    providers: {
      "azure-foundry": {
        baseUrl: "https://my-resource.openai.azure.com/openai/v1",
        apiKey: "AZURE_FOUNDRY_API_KEY",
        api: "openai-completions",
      },
    },
  },
}
```

## Automatic model discovery

When an API key and endpoint are detected, OpenClaw can discover available models
from the Azure `/models` endpoint. Discovery is cached (default: 1 hour).

Config options live under `models.azureFoundryDiscovery`:

```json5
{
  models: {
    azureFoundryDiscovery: {
      enabled: true,
      endpoint: "https://my-resource.openai.azure.com",
      providerFilter: ["openai", "deepseek", "meta"],
      refreshInterval: 3600,
      defaultContextWindow: 32000,
      defaultMaxTokens: 4096,
    },
  },
}
```

Notes:

- `enabled` defaults to `true` when an API key is present.
- `endpoint` defaults to `AZURE_FOUNDRY_ENDPOINT` env var, then `https://models.inference.ai.azure.com`.
- `providerFilter` matches Azure model provider names (e.g. `openai`, `meta`, `deepseek`).
- `refreshInterval` is seconds; set to `0` to disable caching.
- `defaultContextWindow` (default: `32000`) and `defaultMaxTokens` (default: `4096`)
  are used for discovered models when the API doesn't report them.

## Anthropic (Claude) models

Azure AI Foundry hosts Anthropic models at a separate `/anthropic` endpoint path.
OpenClaw automatically routes Claude models to this endpoint using the `anthropic-messages`
API, so no extra configuration is needed. Both catalog and discovered Claude models work
under the same `azure-foundry` provider.

```json5
{
  agents: { defaults: { model: { primary: "azure-foundry/claude-sonnet-4-6" } } },
}
```

Built-in Claude models: `claude-sonnet-4-6`, `claude-sonnet-4-5-20250514`, `claude-haiku-3-5-20241022`.

Claude models discovered via the `/models` endpoint are also automatically detected and
routed to the Anthropic endpoint.

## Audio transcription (STT)

Azure Foundry can transcribe audio using Whisper or GPT-4o-mini-transcribe deployments.

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "azure-foundry", model: "whisper" }],
      },
    },
  },
}
```

The default audio model is `gpt-4o-mini-transcribe`. STT uses API version `2025-04-01-preview` by default (overridable via `AZURE_FOUNDRY_API_VERSION`).

Two URL patterns are supported:

- **Full deployment URL:** `https://<resource>.openai.azure.com/openai/deployments/<model>`
- **Bare endpoint:** `https://<resource>.openai.azure.com` (model name is appended automatically)

## Text-to-speech (TTS)

See [TTS docs](/tts) for full configuration. Quick example:

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "azure",
      azure: {
        endpoint: "https://my-resource.openai.azure.com",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        // Optional; defaults to 2025-04-01-preview
        apiVersion: "2025-04-01-preview",
      },
    },
  },
}
```

TTS uses the `api-key` header (Azure cognitive services convention) and the
`/openai/deployments/<model>/audio/speech` endpoint.

## Notes

- Provider aliases `azure`, `azure-ai`, `azureai`, and `azure-ai-foundry` all normalize to `azure-foundry`.
- Auth falls back through: auth profiles, env vars (with aliases), then `models.providers.*.apiKey`.
- Cost fields default to `0` in the built-in catalog (adjust in your config if using a pay-as-you-go deployment).
- Chat uses `Authorization: Bearer` while STT/TTS use the `api-key` header — this matches Azure's own conventions.
- API versions default to `2025-04-01-preview` for STT/TTS and `2024-05-01-preview` for chat/discovery.
