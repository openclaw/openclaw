---
summary: "Tools recherche + fetch web (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - Vous voulez activer web_search ou web_fetch
  - Vous avez besoin setup clé API Brave Search
  - Vous voulez utiliser Perplexity Sonar pour recherche web
title: "Tools Web"
---

# Tools Web

OpenClaw ship deux tools web lightweight :

- `web_search` — Rechercher web via Brave Search API (défaut) ou Perplexity Sonar (direct ou via OpenRouter).
- `web_fetch` — Fetch HTTP + extraction readable (HTML → markdown/texte).

Ce ne sont **pas** automation browser. Pour sites JS-heavy ou logins, utilisez [Tool Browser](/fr-FR/tools/browser).

## Comment ça marche

- `web_search` appelle votre provider configuré et retourne résultats.
  - **Brave** (défaut) : retourne résultats structurés (titre, URL, snippet).
  - **Perplexity** : retourne réponses AI-synthétisées avec citations depuis recherche web real-time.
- Résultats cachés par query pour 15 minutes (configurable).
- `web_fetch` fait GET HTTP plain et extrait contenu readable (HTML → markdown/texte). N'exécute **pas** JavaScript.
- `web_fetch` activé par défaut (sauf si explicitement désactivé).

## Choisir provider recherche

| Provider           | Pros                                           | Cons                                     | Clé API                                      |
| ------------------ | ---------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **Brave** (défaut) | Rapide, résultats structurés, tier gratuit     | Résultats recherche traditionnels        | `BRAVE_API_KEY`                              |
| **Perplexity**     | Réponses AI-synthétisées, citations, real-time | Nécessite accès Perplexity ou OpenRouter | `OPENROUTER_API_KEY` ou `PERPLEXITY_API_KEY` |

Voir [Setup Brave Search](/fr-FR/brave-search) et [Perplexity Sonar](/fr-FR/perplexity) pour détails spécifiques provider.

Définir provider dans config :

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // ou "perplexity"
      },
    },
  },
}
```

Exemple : switch vers Perplexity Sonar (API direct) :

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Obtenir clé API Brave

1. Créer compte Brave Search API à [https://brave.com/search/api/](https://brave.com/search/api/)
2. Dans dashboard, choisir plan **Data for Search** (pas "Data for AI") et générer clé API.
3. Run `openclaw configure --section web` pour stocker clé dans config (recommandé), ou définir `BRAVE_API_KEY` dans environnement.

Brave fournit tier gratuit plus plans payants ; vérifier portail API Brave pour limites et pricing actuels.

## Configuration complète

```json5
{
  tools: {
    web: {
      enabled: true,
      search: {
        enabled: true,
        provider: "brave",
        brave: {
          apiKey: "${BRAVE_API_KEY}",
          maxResults: 10,
          cacheMinutes: 15,
        },
      },
      fetch: {
        enabled: true,
        maxLength: 20000,
        timeout: 30000,
        userAgent: "Mozilla/5.0 (compatible; OpenClaw/1.0)",
      },
    },
  },
}
```

## Utilisation

### web_search

**Recherche basique :**

```json
{
  "tool": "web_search",
  "query": "OpenClaw agent framework"
}
```

**Avec options :**

```json
{
  "tool": "web_search",
  "query": "climate change solutions",
  "maxResults": 5,
  "freshness": "week"
}
```

### web_fetch

**Fetch basique :**

```json
{
  "tool": "web_fetch",
  "url": "https://example.com/article"
}
```

**Avec options :**

```json
{
  "tool": "web_fetch",
  "url": "https://docs.example.com/guide",
  "maxLength": 10000,
  "raw": false
}
```

## Options web_search

- `query` (requis) : termes recherche
- `maxResults` (optionnel) : nombre résultats (défaut : 10)
- `freshness` (optionnel) : `day` | `week` | `month` | `year`
- `country` (optionnel) : code pays (ex : `fr`)
- `language` (optionnel) : code langue (ex : `fr`)

## Options web_fetch

- `url` (requis) : URL à fetch
- `maxLength` (optionnel) : longueur max contenu (défaut : 20000)
- `raw` (optionnel) : retourner HTML raw vs markdown (défaut : false)
- `timeout` (optionnel) : timeout ms (défaut : 30000)

## Perplexity Sonar

Perplexity fournit réponses AI-synthétisées avec citations web real-time.

**Direct API :**

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "${PERPLEXITY_API_KEY}",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Via OpenRouter :**

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "${OPENROUTER_API_KEY}",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Cache

Résultats recherche cachés pour réduire appels API :

```json5
{
  tools: {
    web: {
      search: {
        cacheMinutes: 15, // Défaut
      },
    },
  },
}
```

Clear cache :

```bash
openclaw cache clear --section web-search
```

## Limites Rate

**Brave Search :**

- Tier gratuit : 2000 requêtes/mois
- Plans payants : limites plus hautes

**Perplexity :**

- Varie selon plan abonnement
- Vérifier dashboard Perplexity

## Dépannage

**Recherche échoue :**

```bash
# Vérifier clé API
openclaw config get tools.web.search.brave.apiKey

# Tester directement
openclaw web search "test query"

# Voir logs
tail -f ~/.openclaw/logs/gateway.log
```

**Fetch timeout :**

```bash
# Augmenter timeout
openclaw config set tools.web.fetch.timeout 60000

# Tester URL manuellement
curl -I https://example.com
```

**Rate limit hit :**

```bash
# Vérifier usage
openclaw web stats

# Augmenter cache duration
openclaw config set tools.web.search.cacheMinutes 60
```

## Alternatives

Pour sites nécessitant JavaScript ou interaction complexe :

- [Browser](/fr-FR/tools/browser) : automation browser complète
- [Puppeteer skill](/fr-FR/tools/skills) : scripting browser custom

Voir aussi :

- [Browser](/fr-FR/tools/browser)
- [Brave Search](/fr-FR/brave-search)
- [Perplexity](/fr-FR/perplexity)
- [Skills](/fr-FR/tools/skills)
