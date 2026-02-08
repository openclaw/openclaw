---
title: "Vercel AI Gateway"
summary: "Configuration de Vercel AI Gateway (authentification + selection du modele)"
read_when:
  - Vous souhaitez utiliser Vercel AI Gateway avec OpenClaw
  - Vous avez besoin de la variable d'environnement de cle API ou du choix d'authentification via la CLI
x-i18n:
  source_path: providers/vercel-ai-gateway.md
  source_hash: 2bf1687c1152c6e1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:30Z
---

# Vercel AI Gateway

Le [Vercel AI Gateway](https://vercel.com/ai-gateway) fournit une API unifiee pour acceder a des centaines de modeles via un point de terminaison unique.

- Fournisseur : `vercel-ai-gateway`
- Authentification : `AI_GATEWAY_API_KEY`
- API : compatible avec Anthropic Messages

## Demarrage rapide

1. Definissez la cle API (recommande : la stocker pour le Gateway (passerelle)) :

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Definissez un modele par defaut :

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Exemple non interactif

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Note sur l'environnement

Si le Gateway (passerelle) s'execute en tant que daemon (launchd/systemd), assurez-vous que `AI_GATEWAY_API_KEY`
est disponible pour ce processus (par exemple, dans `~/.openclaw/.env` ou via
`env.shellEnv`).
