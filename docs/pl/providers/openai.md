---
summary: "„Korzystaj z OpenAI za pomocą kluczy API lub subskrypcji Codex w OpenClaw”"
read_when:
  - Chcesz używać modeli OpenAI w OpenClaw
  - Chcesz używać uwierzytelniania subskrypcją Codex zamiast kluczy API
title: "OpenAI"
---

# OpenAI

OpenAI udostępnia deweloperskie interfejsy API dla modeli GPT. Codex obsługuje **logowanie do ChatGPT** dla dostępu w ramach subskrypcji lub logowanie **kluczem API** dla dostępu rozliczanego według użycia. Chmura Codex wymaga logowania do ChatGPT.

## Opcja A: Klucz API OpenAI (OpenAI Platform)

**Najlepsze dla:** bezpośredniego dostępu do API i rozliczeń według użycia.
Uzyskaj klucz API z panelu OpenAI.

### Konfiguracja CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Fragment konfiguracji

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Opcja B: Subskrypcja OpenAI Code (Codex)

**Najlepsze dla:** korzystania z dostępu subskrypcyjnego ChatGPT/Codex zamiast klucza API.
Chmura Codex wymaga logowania do ChatGPT, natomiast CLI Codex obsługuje logowanie do ChatGPT lub kluczem API.

### Konfiguracja CLI (OAuth Codex)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Fragment konfiguracji (subskrypcja Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Uwagi

- Odwołania do modeli zawsze używają `provider/model` (zob. [/concepts/models](/concepts/models)).
- Szczegóły uwierzytelniania oraz zasady ponownego użycia znajdują się w [/concepts/oauth](/concepts/oauth).
