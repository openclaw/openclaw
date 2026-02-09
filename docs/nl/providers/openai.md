---
summary: "Gebruik OpenAI via API-sleutels of een Codex-abonnement in OpenClaw"
read_when:
  - Je wilt OpenAI-modellen gebruiken in OpenClaw
  - Je wilt authenticatie via een Codex-abonnement in plaats van API-sleutels
title: "OpenAI"
---

# OpenAI

OpenAI biedt ontwikkelaars-API's voor GPT-modellen. Codex ondersteunt **ChatGPT-aanmelding** voor toegang via een abonnement
of **API-sleutel**-aanmelding voor gebruiksgebaseerde toegang. Codex cloud vereist ChatGPT-aanmelding.

## Optie A: OpenAI API-sleutel (OpenAI Platform)

**Het beste voor:** directe API-toegang en gebruiksgebaseerde facturering.
Haal je API-sleutel op via het OpenAI-dashboard.

### CLI-installatie

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Config-fragment

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Optie B: OpenAI Code (Codex)-abonnement

**Het beste voor:** het gebruiken van ChatGPT/Codex-abonnementstoegang in plaats van een API-sleutel.
Codex cloud vereist ChatGPT-aanmelding, terwijl de Codex CLI ChatGPT- of API-sleutel-aanmelding ondersteunt.

### CLI-installatie (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Config-fragment (Codex-abonnement)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notities

- Modelreferenties gebruiken altijd `provider/model` (zie [/concepts/models](/concepts/models)).
- Authenticatiedetails en hergebruikregels staan in [/concepts/oauth](/concepts/oauth).
