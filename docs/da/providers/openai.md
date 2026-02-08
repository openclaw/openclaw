---
summary: "Brug OpenAI via API-nøgler eller Codex-abonnement i OpenClaw"
read_when:
  - Du vil bruge OpenAI-modeller i OpenClaw
  - Du vil bruge Codex-abonnementsautentificering i stedet for API-nøgler
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:26Z
---

# OpenAI

OpenAI stiller udvikler-API’er til rådighed for GPT-modeller. Codex understøtter **ChatGPT-login** for abonnementsadgang
eller **API-nøgle**-login for brugsbaseret adgang. Codex cloud kræver ChatGPT-login.

## Mulighed A: OpenAI API-nøgle (OpenAI Platform)

**Bedst til:** direkte API-adgang og brugsbaseret fakturering.
Hent din API-nøgle fra OpenAI-dashboardet.

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

**Bedst til:** brug af ChatGPT/Codex-abonnementsadgang i stedet for en API-nøgle.
Codex cloud kræver ChatGPT-login, mens Codex CLI understøtter ChatGPT- eller API-nøgle-login.

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
