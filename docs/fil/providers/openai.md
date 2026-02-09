---
summary: "Gamitin ang OpenAI sa pamamagitan ng mga API key o Codex subscription sa OpenClaw"
read_when:
  - Gusto mong gumamit ng mga OpenAI model sa OpenClaw
  - Gusto mo ng Codex subscription auth sa halip na mga API key
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription
access or **API key** sign-in for usage-based access. Codex cloud requires ChatGPT sign-in.

## Opsyon A: OpenAI API key (OpenAI Platform)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

### Setup ng CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Snippet ng config

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Opsyon B: OpenAI Code (Codex) subscription

**Best for:** using ChatGPT/Codex subscription access instead of an API key.
Codex cloud requires ChatGPT sign-in, while the Codex CLI supports ChatGPT or API key sign-in.

### Setup ng CLI (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Snippet ng config (Codex subscription)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Mga tala

- Palaging gumagamit ang mga model ref ng `provider/model` (tingnan ang [/concepts/models](/concepts/models)).
- Ang mga detalye ng auth at mga patakaran sa reuse ay nasa [/concepts/oauth](/concepts/oauth).
