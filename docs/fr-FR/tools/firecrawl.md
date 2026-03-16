---
summary: "Fallback Firecrawl pour web_fetch (anti-bot + extraction en cache)"
read_when:
  - Vous souhaitez une extraction web via Firecrawl
  - Vous avez besoin d'une clé API Firecrawl
  - Vous voulez une extraction anti-bot pour web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw peut utiliser **Firecrawl** comme extracteur de secours pour `web_fetch`. Il s'agit d'un service d'extraction de contenu hébergé qui supporte le contournement des bots et la mise en cache, ce qui aide avec les sites riches en JS ou les pages qui bloquent les requêtes HTTP simples.

## Obtenir une clé API

1. Créez un compte Firecrawl et générez une clé API.
2. Stockez-la dans la configuration ou définissez `FIRECRAWL_API_KEY` dans l'environnement de la passerelle.

## Configurer Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_ICI",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Remarques :

- `firecrawl.enabled` vaut true par défaut lorsqu'une clé API est présente.
- `maxAgeMs` contrôle l'âge maximal des résultats en cache (ms). Par défaut 2 jours.

## Mode furtif / contournement de bot

Firecrawl expose un paramètre **mode proxy** pour le contournement de bot (`basic`, `stealth`, ou `auto`).
OpenClaw utilise toujours `proxy: "auto"` plus `storeInCache: true` pour les requêtes Firecrawl.
Si le proxy est omis, Firecrawl utilise `auto` par défaut. `auto` réessaie avec des proxies furtifs si une tentative basique échoue, ce qui peut utiliser plus de crédits qu'un scraping basique uniquement.

## Comment `web_fetch` utilise Firecrawl

Ordre d'extraction de `web_fetch` :

1. Readability (local)
2. Firecrawl (si configuré)
3. Nettoyage HTML basique (dernier recours)

Voir [Outils Web](/fr-FR/tools/web) pour la configuration complète des outils web.
