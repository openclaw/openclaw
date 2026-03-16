---
title: "Cloudflare AI Gateway"
summary: "Configuration Cloudflare AI Gateway (auth + sélection de modèle)"
read_when:
  - Vous voulez utiliser Cloudflare AI Gateway avec OpenClaw
  - Vous avez besoin de l'ID de compte, l'ID de passerelle, ou de la variable env de clé API
---

# Cloudflare AI Gateway

Cloudflare AI Gateway se situe devant les APIs de fournisseur et vous permet d'ajouter des analyses, mise en cache et contrôles. Pour Anthropic, OpenClaw utilise l'API Anthropic Messages via votre point de terminaison Gateway.

- Fournisseur : `cloudflare-ai-gateway`
- URL de base : `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Modèle par défaut : `cloudflare-ai-gateway/claude-sonnet-4-5`
- Clé API : `CLOUDFLARE_AI_GATEWAY_API_KEY` (votre clé API de fournisseur pour les requêtes via la Gateway)

Pour les modèles Anthropic, utilisez votre clé API Anthropic.

## Démarrage rapide

1. Définissez la clé API du fournisseur et les détails Gateway :

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Définissez un modèle par défaut :

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Exemple non interactif

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "votre-id-compte" \
  --cloudflare-ai-gateway-gateway-id "votre-id-gateway" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Passerelles authentifiées

Si vous avez activé l'authentification Gateway dans Cloudflare, ajoutez l'en-tête `cf-aig-authorization` (ceci s'ajoute à votre clé API de fournisseur).

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## Note sur l'environnement

Si la Passerelle s'exécute comme daemon (launchd/systemd), assurez-vous que `CLOUDFLARE_AI_GATEWAY_API_KEY` est disponible pour ce processus (par exemple, dans `~/.openclaw/.env` ou via `env.shellEnv`).
