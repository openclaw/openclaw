---
summary: "Utiliser Xiaomi MiMo (mimo-v2-flash) avec OpenClaw"
read_when:
  - Vous souhaitez utiliser les modeles Xiaomi MiMo dans OpenClaw
  - Vous avez besoin de configurer XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo est la plateforme d’API pour les modeles **MiMo**. Elle fournit des API REST compatibles avec
les formats OpenAI et Anthropic et utilise des cles d’API pour l’authentification. Creez votre cle d’API dans
la [console Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw utilise
le fournisseur `xiaomi` avec une cle d’API Xiaomi MiMo.

## Apercu des modeles

- **mimo-v2-flash** : fenetre de contexte de 262144 tokens, compatible avec l’API Anthropic Messages.
- URL de base : `https://api.xiaomimimo.com/anthropic`
- Autorisation : `Bearer $XIAOMI_API_KEY`

## Configuration CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Extrait de configuration

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
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

- Reference du modele : `xiaomi/mimo-v2-flash`.
- Le fournisseur est injecte automatiquement lorsque `XIAOMI_API_KEY` est defini (ou lorsqu’un profil d’authentification existe).
- Voir [/concepts/model-providers](/concepts/model-providers) pour les regles des fournisseurs.
