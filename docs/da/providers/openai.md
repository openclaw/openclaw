---
summary: "Brug OpenAI via API-nøgler eller Codex-abonnement i OpenClaw"
read_when:
  - Du vil bruge OpenAI-modeller i OpenClaw
  - Du vil bruge Codex-abonnementsautentificering i stedet for API-nøgler
title: "OpenAI"
---

# OpenAI

OpenAI leverer udviklerAPI'er til GPT-modeller. Codex understøtter **ChatGPT log-in** for abonnement
adgang eller **API nøgle** log-in for bruger-baseret adgang. Codex cloud kræver ChatGPT login.

## Mulighed A: OpenAI API-nøgle (OpenAI Platform)

**Bedst for:** direkte API-adgang og brugerbaseret fakturering.
Hent din API-nøgle fra OpenAI dashboard.

### CLI-opsætning

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Konfigurationsudsnit

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Mulighed B: OpenAI Code (Codex) abonnement

**Bedst for:** ved hjælp af ChatGPT/Codex abonnementsadgang i stedet for en API-nøgle.
Codex cloud kræver ChatGPT login, mens Codex CLI understøtter ChatGPT eller API-nøglelogin.

### CLI-opsætning (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Konfigurationsudsnit (Codex-abonnement)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Noter

- Modelreferencer bruger altid `provider/model` (se [/concepts/models](/concepts/models)).
- Autentificeringsdetaljer + genbrugsregler findes i [/concepts/oauth](/concepts/oauth).
