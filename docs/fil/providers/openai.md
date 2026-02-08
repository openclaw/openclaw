---
summary: "Gamitin ang OpenAI sa pamamagitan ng mga API key o Codex subscription sa OpenClaw"
read_when:
  - Gusto mong gumamit ng mga OpenAI model sa OpenClaw
  - Gusto mo ng Codex subscription auth sa halip na mga API key
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# OpenAI

Nagbibigay ang OpenAI ng mga developer API para sa mga GPT model. Sinusuportahan ng Codex ang **ChatGPT sign-in** para sa access na may subscription o **API key** sign-in para sa usage-based na access. Kinakailangan ng Codex cloud ang ChatGPT sign-in.

## Opsyon A: OpenAI API key (OpenAI Platform)

**Pinakamainam para sa:** direktang API access at usage-based na pagsingil.
Kunin ang iyong API key mula sa OpenAI dashboard.

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

**Pinakamainam para sa:** paggamit ng ChatGPT/Codex subscription access sa halip na API key.
Kinakailangan ng Codex cloud ang ChatGPT sign-in, habang sinusuportahan ng Codex CLI ang ChatGPT o API key sign-in.

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
