---
title: "Vercel AI Gateway"
summary: "Configuration de Vercel AI Gateway (auth + sélection de modèle)"
read_when:
  - Vous souhaitez utiliser Vercel AI Gateway avec OpenClaw
  - Vous avez besoin de la variable d'env de clé API ou du choix d'auth CLI
---

# Vercel AI Gateway

La [Vercel AI Gateway](https://vercel.com/ai-gateway) fournit une API unifiée pour accéder à des centaines de modèles via un seul endpoint.

- Fournisseur : `vercel-ai-gateway`
- Auth : `AI_GATEWAY_API_KEY`
- API : Compatible Anthropic Messages

## Démarrage rapide

1. Définir la clé API (recommandé : la stocker pour la Passerelle) :

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Définir un modèle par défaut :

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Exemple non-interactif

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Remarque sur l'environnement

Si la Passerelle s'exécute en tant que daemon (launchd/systemd), assurez-vous que `AI_GATEWAY_API_KEY` est disponible pour ce processus (par exemple, dans `~/.openclaw/.env` ou via `env.shellEnv`).
