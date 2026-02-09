---
title: "Cloudflare AI Gateway"
summary: "Configuration de Cloudflare AI Gateway (authentification + selection du modele)"
read_when:
  - Vous souhaitez utiliser Cloudflare AI Gateway avec OpenClaw
  - Vous avez besoin de l’ID de compte, de l’ID de Gateway (passerelle) ou de la variable d’environnement de cle API
---

# Cloudflare AI Gateway

Cloudflare AI Gateway se place devant les API des fournisseurs et vous permet d’ajouter des analyses, de la mise en cache et des controles. Pour Anthropic, OpenClaw utilise l’API Anthropic Messages via le point de terminaison de votre Gateway (passerelle).

- Fournisseur : `cloudflare-ai-gateway`
- URL de base : `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Modele par defaut : `cloudflare-ai-gateway/claude-sonnet-4-5`
- Cle API : `CLOUDFLARE_AI_GATEWAY_API_KEY` (votre cle API fournisseur pour les requetes via la Gateway)

Pour les modeles Anthropic, utilisez votre cle API Anthropic.

## Demarrage rapide

1. Definissez la cle API du fournisseur et les details de la Gateway :

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Definissez un modele par defaut :

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
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Gateways authentifiees

Si vous avez active l’authentification de la Gateway dans Cloudflare, ajoutez l’en-tete `cf-aig-authorization` (en plus de votre cle API fournisseur).

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

## Note sur l’environnement

Si la Gateway s’execute en tant que demon (launchd/systemd), assurez-vous que `CLOUDFLARE_AI_GATEWAY_API_KEY` est disponible pour ce processus (par exemple, dans `~/.openclaw/.env` ou via `env.shellEnv`).
