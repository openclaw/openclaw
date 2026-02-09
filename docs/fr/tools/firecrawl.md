---
summary: "Solution de repli Firecrawl pour web_fetch (anti-bot + extraction mise en cache)"
read_when:
  - Vous souhaitez une extraction web adossée à Firecrawl
  - Vous avez besoin d'une clé API Firecrawl
  - Vous souhaitez une extraction anti-bot pour web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw peut utiliser **Firecrawl** comme extracteur de secours pour `web_fetch`. Il s’agit d’un service d’extraction de contenu hébergé qui prend en charge le contournement des bots et la mise en cache, ce qui aide avec les sites riches en JS ou les pages qui bloquent les récupérations HTTP simples.

## Obtenir une clé API

1. Créez un compte Firecrawl et générez une clé API.
2. Stockez-la dans la configuration ou définissez `FIRECRAWL_API_KEY` dans l’environnement de la Gateway (passerelle).

## Configurer Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
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

Notes :

- `firecrawl.enabled` est défini par défaut sur true lorsqu’une clé API est présente.
- `maxAgeMs` contrôle l’ancienneté maximale des résultats mis en cache (ms). La valeur par défaut est de 2 jours.

## Furtivité / contournement des bots

Firecrawl expose un paramètre de **mode proxy** pour le contournement des bots (`basic`, `stealth` ou `auto`).
OpenClaw utilise toujours `proxy: "auto"` plus `storeInCache: true` pour les requêtes Firecrawl.
Si le proxy est omis, Firecrawl utilise par défaut `auto`. `auto` réessaie avec des proxys furtifs si une tentative basique échoue, ce qui peut consommer plus de crédits que le scraping basique uniquement.

## Comment `web_fetch` utilise Firecrawl

Ordre d’extraction de `web_fetch` :

1. Readability (local)
2. Firecrawl (si configuré)
3. Nettoyage HTML basique (dernier recours)

Voir [Outils web](/tools/web) pour la configuration complète des outils web.
