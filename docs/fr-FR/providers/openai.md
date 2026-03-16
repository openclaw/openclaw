---
summary: "Utilisez OpenAI via des clés API ou abonnement Codex dans OpenClaw"
read_when:
  - Vous voulez utiliser les modèles OpenAI dans OpenClaw
  - Vous voulez l'auth par abonnement Codex au lieu de clés API
title: "OpenAI"
---

# OpenAI

OpenAI fournit des API de développeur pour les modèles GPT. Codex supporte **la connexion ChatGPT** pour l'accès par abonnement ou **la connexion par clé API** pour l'accès basé sur l'utilisation. Codex cloud nécessite la connexion ChatGPT.

## Option A : Clé API OpenAI (Plateforme OpenAI)

**Meilleur pour :** accès API direct et facturation basée sur l'utilisation.
Obtenez votre clé API depuis le tableau de bord OpenAI.

### Configuration CLI

```bash
openclaw onboard --auth-choice openai-api-key
# ou non-interactif
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Extrait de config

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Option B : Abonnement OpenAI Code (Codex)

**Meilleur pour :** utiliser l'accès par abonnement ChatGPT/Codex au lieu d'une clé API.
Codex cloud nécessite la connexion ChatGPT, tandis que le CLI Codex supporte la connexion ChatGPT ou clé API.

### Configuration CLI (OAuth Codex)

```bash
# Exécuter OAuth Codex dans le wizard
openclaw onboard --auth-choice openai-codex

# Ou exécuter OAuth directement
openclaw models auth login --provider openai-codex
```

### Extrait de config (abonnement Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notes

- Les références de modèle utilisent toujours `provider/model` (voir [/concepts/models](/fr-FR/concepts/models)).
- Les détails d'auth + règles de réutilisation sont dans [/concepts/oauth](/fr-FR/concepts/oauth).
