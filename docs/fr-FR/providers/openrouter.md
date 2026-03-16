---
summary: "Utiliser l'API unifiée d'OpenRouter pour accéder à de nombreux modèles dans OpenClaw"
read_when:
  - Vous souhaitez une seule clé API pour de nombreux LLM
  - Vous voulez exécuter des modèles via OpenRouter dans OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter fournit une **API unifiée** qui route les requêtes vers de nombreux modèles derrière un seul endpoint et une seule clé API. C'est compatible OpenAI, donc la plupart des SDK OpenAI fonctionnent en changeant simplement l'URL de base.

## Configuration CLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Extrait de configuration

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Remarques

- Les références de modèles sont `openrouter/<fournisseur>/<modèle>`.
- Pour plus d'options modèle/fournisseur, voir [/fr-FR/concepts/model-providers](/fr-FR/concepts/model-providers).
- OpenRouter utilise un token Bearer avec votre clé API en coulisses.
