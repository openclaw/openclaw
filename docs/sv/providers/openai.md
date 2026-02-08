---
summary: "Använd OpenAI via API-nycklar eller Codex-prenumeration i OpenClaw"
read_when:
  - Du vill använda OpenAI-modeller i OpenClaw
  - Du vill använda Codex-prenumerationsautentisering i stället för API-nycklar
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:10Z
---

# OpenAI

OpenAI tillhandahåller utvecklar-API:er för GPT-modeller. Codex stöder **ChatGPT-inloggning** för
prenumerationsåtkomst eller **API-nyckel**-inloggning för användningsbaserad åtkomst. Codex Cloud
kräver ChatGPT-inloggning.

## Alternativ A: OpenAI API-nyckel (OpenAI Platform)

**Bäst för:** direkt API-åtkomst och användningsbaserad debitering.
Hämta din API-nyckel från OpenAI-instrumentpanelen.

### CLI-konfigurering

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Konfigutdrag

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Alternativ B: OpenAI Code (Codex)-prenumeration

**Bäst för:** att använda ChatGPT/Codex-prenumerationsåtkomst i stället för en API-nyckel.
Codex Cloud kräver ChatGPT-inloggning, medan Codex CLI stöder ChatGPT- eller API-nyckel-inloggning.

### CLI-konfigurering (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Konfigutdrag (Codex-prenumeration)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Noteringar

- Modellreferenser använder alltid `provider/model` (se [/concepts/models](/concepts/models)).
- Autentiseringsdetaljer och regler för återanvändning finns i [/concepts/oauth](/concepts/oauth).
