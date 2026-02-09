---
summary: "Utilisez l’API unifiée d’OpenRouter pour accéder à de nombreux modèles dans OpenClaw"
read_when:
  - Vous souhaitez une seule clé API pour de nombreux LLM
  - Vous souhaitez exécuter des modèles via OpenRouter dans OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter fournit une **API unifiée** qui achemine les requêtes vers de nombreux modèles derrière un seul
endpoint et une seule clé API. Elle est compatible OpenAI, de sorte que la plupart des SDK OpenAI fonctionnent en changeant simplement l’URL de base.

## Configuration de la CLI

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

## Notes

- Les références de modèle sont `openrouter/<provider>/<model>`.
- Pour plus d’options de modèles/fournisseurs, voir [/concepts/model-providers](/concepts/model-providers).
- OpenRouter utilise un jeton Bearer avec votre clé API en arrière-plan.
