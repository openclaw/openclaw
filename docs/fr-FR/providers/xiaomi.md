---
summary: "Utilisez Xiaomi MiMo (mimo-v2-flash) avec OpenClaw"
read_when:
  - Vous voulez les modèles Xiaomi MiMo dans OpenClaw
  - Vous avez besoin de la configuration XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo est la plateforme API pour les modèles **MiMo**. Elle fournit des APIs REST compatibles avec les formats OpenAI et Anthropic et utilise des clés API pour l'authentification. Créez votre clé API dans la [console Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw utilise le fournisseur `xiaomi` avec une clé API Xiaomi MiMo.

## Aperçu du modèle

- **mimo-v2-flash** : fenêtre de contexte de 262 144 tokens, compatible API Anthropic Messages.
- URL de base : `https://api.xiaomimimo.com/anthropic`
- Autorisation : `Bearer $XIAOMI_API_KEY`

## Configuration CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# ou non interactif
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Extrait de config

```json5
{
  env: { XIAOMI_API_KEY: "votre-cle" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notes

- Réf modèle : `xiaomi/mimo-v2-flash`.
- Le fournisseur est injecté automatiquement quand `XIAOMI_API_KEY` est défini (ou qu'un profil auth existe).
- Voir [/fr-FR/concepts/model-providers](/fr-FR/concepts/model-providers) pour les règles de fournisseur.
