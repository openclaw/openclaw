---
summary: "Configuration de l'API Brave Search pour web_search"
read_when:
  - Vous voulez utiliser Brave Search pour web_search
  - Vous avez besoin d'une BRAVE_API_KEY ou de détails de plan
title: "Brave Search"
---

# API Brave Search

OpenClaw utilise Brave Search comme fournisseur par défaut pour `web_search`.

## Obtenir une clé API

1. Créez un compte API Brave Search sur [https://brave.com/search/api/](https://brave.com/search/api/)
2. Dans le tableau de bord, choisissez le plan **Data for Search** et générez une clé API.
3. Stockez la clé dans la config (recommandé) ou définissez `BRAVE_API_KEY` dans l'environnement de Passerelle.

## Exemple de config

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_ICI",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Notes

- Le plan Data for AI n'est **pas** compatible avec `web_search`.
- Brave fournit un niveau gratuit plus des plans payants ; vérifiez le portail API Brave pour les limites actuelles.

Voir [Outils Web](/fr-FR/tools/web) pour la configuration complète de web_search.
