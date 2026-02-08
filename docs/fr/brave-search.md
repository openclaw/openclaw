---
summary: "Configuration de l’API Brave Search pour web_search"
read_when:
  - Vous souhaitez utiliser Brave Search pour web_search
  - Vous avez besoin d’une BRAVE_API_KEY ou de details sur les offres
title: "Brave Search"
x-i18n:
  source_path: brave-search.md
  source_hash: cdcb037b092b8a10
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:23Z
---

# API Brave Search

OpenClaw utilise Brave Search comme fournisseur par defaut pour `web_search`.

## Obtenir une cle API

1. Creez un compte API Brave Search sur https://brave.com/search/api/
2. Dans le tableau de bord, choisissez l’offre **Data for Search** et generez une cle API.
3. Stockez la cle dans la configuration (recommande) ou definissez `BRAVE_API_KEY` dans l’environnement du Gateway (passerelle).

## Exemple de configuration

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Notes

- L’offre Data for AI n’est **pas** compatible avec `web_search`.
- Brave propose un palier gratuit ainsi que des offres payantes ; consultez le portail de l’API Brave pour connaitre les limites actuelles.

Voir [Web tools](/tools/web) pour la configuration complete de web_search.
