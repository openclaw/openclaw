---
summary: "Utiliser OpenAI via des clés API ou un abonnement Codex dans OpenClaw"
read_when:
  - Vous souhaitez utiliser des modèles OpenAI dans OpenClaw
  - Vous souhaitez une authentification par abonnement Codex plutôt que par clés API
title: "OpenAI"
---

# OpenAI

OpenAI fournit des API pour développeurs pour les modèles GPT. Codex prend en charge la **connexion ChatGPT** pour l’accès par abonnement ou la **connexion par clé API** pour un accès basé sur l’utilisation. Le cloud Codex nécessite une connexion ChatGPT.

## Option A : Clé API OpenAI (OpenAI Platform)

**Idéal pour :** l’accès direct à l’API et la facturation à l’usage.
Obtenez votre clé API depuis le tableau de bord OpenAI.

### Configuration CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Extrait de configuration

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Option B : Abonnement OpenAI Code (Codex)

**Idéal pour :** utiliser l’accès par abonnement ChatGPT/Codex au lieu d’une clé API.
Le cloud Codex nécessite une connexion ChatGPT, tandis que le CLI Codex prend en charge une connexion ChatGPT ou par clé API.

### Configuration CLI (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Configuration du snippet (abonnement Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notes

- Les références de modèles utilisent toujours `provider/model` (voir [/concepts/models](/concepts/models)).
- Les détails d’authentification et les règles de réutilisation sont décrits dans [/concepts/oauth](/concepts/oauth).
