---
summary: "Use Orq AI Router with OpenClaw"
read_when:
  - You want to route models through Orq AI
  - You need an OpenAI-compatible proxy endpoint
title: "Orq AI Router"
---

# Orq AI Router

Orq AI provides an OpenAI-compatible router endpoint. Configure it as a custom
provider under `models.providers`.

## Onboard

Use the onboarding wizard to add Orq:

```bash
openclaw onboard --auth-choice orq-api-key
```

## Configure

1. Set `ORQ_API_KEY` in your environment or store it in your config.
2. Add the provider entry and models.
3. Set your default model to `orq/<model-id>`.

```json5
{
  env: { ORQ_API_KEY: "orq_..." },
  agents: {
    defaults: { model: { primary: "orq/openai/gpt-5.2" } },
  },
  models: {
    providers: {
      orq: {
        baseUrl: "https://api.orq.ai/v2/router",
        apiKey: "${ORQ_API_KEY}",
        api: "openai-completions",
        models: [
          // Anthropic 4.5
          { id: "anthropic/claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
          { id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
          { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },

          // Gemini 2.5
          { id: "google-ai/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "google-ai/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
          { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro (Vertex AI)" },
          { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (Vertex AI)" },

          // Gemini 3
          { id: "google-ai/gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
          { id: "google-ai/gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
          { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro Preview (Vertex AI)" },
          { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash Preview (Vertex AI)" },

          // GPT-5
          { id: "openai/gpt-5", name: "GPT-5" },
          { id: "openai/gpt-5-mini", name: "GPT-5 Mini" },
          { id: "openai/gpt-5-nano", name: "GPT-5 Nano" },
          { id: "openai/gpt-5.2", name: "GPT-5.2" },

          // Groq
          { id: "groq/llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" },
          { id: "groq/llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
          {
            id: "groq/meta-llama/llama-4-maverick-17b-128e-instruct",
            name: "Llama 4 Maverick 17B 128E Instruct",
          },
          {
            id: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
            name: "Llama 4 Scout 17B 16E Instruct",
          },
          { id: "groq/meta-llama/llama-guard-4-12b", name: "Llama Guard 4 12B" },
          { id: "groq/meta-llama/llama-prompt-guard-2-86m", name: "Llama Prompt Guard 2 86M" },
          { id: "groq/moonshotai/kimi-k2-instruct", name: "Kimi K2 Instruct" },
          { id: "groq/moonshotai/kimi-k2-instruct-0905", name: "Kimi K2 Instruct 0905" },
          { id: "groq/openai/gpt-oss-120b", name: "GPT OSS 120B (Groq)" },
          { id: "groq/openai/gpt-oss-20b", name: "GPT OSS 20B (Groq)" },
          { id: "groq/qwen/qwen3-32b", name: "Qwen 3 32B (Groq)" },

          // Cerebras
          { id: "cerebras/gpt-oss-120b", name: "GPT OSS 120B (Cerebras)" },
          { id: "cerebras/llama-3.3-70b", name: "Llama 3.3 70B (Cerebras)" },
          { id: "cerebras/llama3.1-8b", name: "Llama 3.1 8B (Cerebras)" },
          {
            id: "cerebras/qwen-3-235b-a22b-instruct-2507",
            name: "Qwen 3 235B A22B Instruct 2507 (Cerebras)",
          },
          { id: "cerebras/qwen-3-32b", name: "Qwen 3 32B (Cerebras)" },
          { id: "cerebras/zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

## Notes

- Use `api: "openai-responses"` if you prefer the OpenAI Responses format.
- Orq model IDs include provider prefixes (for example `openai/gpt-5.2`), so reference them as `orq/openai/gpt-5.2`.
- Orq uses `google-ai/*` for Gemini (Google AI) and `google/*` for Vertex AI (GCP).
- Add model pricing or context metadata when you have it from Orq.
