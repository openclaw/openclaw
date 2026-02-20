---
title: "Cencori"
summary: "Cencori setup (auth + model selection)"
read_when:
  - You want to use Cencori with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Cencori

[Cencori](https://cencori.com) is a **Cloud Intelligence Provider (CIP)** — the unified infrastructure layer for the AI-first world.

- Provider: `cencori`
- Auth: `CENCORI_API_KEY`
- Base URL: `https://cencori.com/api/v1`
- API: OpenAI-compatible chat/completions
- Default model: `cencori/gpt-4o`

## Before you begin

To get the most out of Cencori, we recommend having the following ready:

- A [Cencori account](https://cencori.com/signup) to access your project dashboard.
- An API key for at least one AI provider (OpenAI, Anthropic, or Google).
- A basic understanding of [AI Gateway concepts](/docs/ai/gateway).

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
openclaw onboard --auth-choice cencori-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cencori/gpt-4o" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cencori-api-key \
  --cencori-api-key "$CENCORI_API_KEY"
```

## Products

Cencori is built on products that handle the heavy lifting of AI infrastructure:

1. **AI Gateway**: A single, secure endpoint for all your model routing.
2. **Compute**: Secure, ephemeral execution for AI agents and logic.
3. **Workflow**: Visual orchestration for multi-step AI pipelines.
4. **Data Storage**: AI-native storage for context, vector sync, and integrity.
5. **Integration**: Pre-built connectors to external tools and databases.

## SDKs & Integrations

Cencori is designed to work where your code already lives. We provide three primary integration paths:

- **Official SDKs**: Dedicated, feature-rich libraries for **TypeScript**, **Python**, and **Go**.
- **Framework Adapters**: Deep integrations for **Vercel AI SDK**, **TanStack AI**, and **LangChain**.
- **Universal Proxy**: Use your existing OpenAI or Anthropic SDKs by simply changing the `base_url`. We are 100% compatible with the native ecosystem.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `CENCORI_API_KEY` is available to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).
