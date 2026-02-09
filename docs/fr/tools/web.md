---
summary: "Outils de recherche et de récupération web (API Brave Search, Perplexity direct/OpenRouter)"
read_when:
  - Vous souhaitez activer web_search ou web_fetch
  - Vous avez besoin de configurer une clé API Brave Search
  - Vous souhaitez utiliser Perplexity Sonar pour la recherche web
title: "Outils Web"
---

# Outils web

OpenClaw fournit deux outils web légers :

- `web_search` — Recherche sur le web via l’API Brave Search (par défaut) ou Perplexity Sonar (direct ou via OpenRouter).
- `web_fetch` — Récupération HTTP + extraction lisible (HTML → markdown/texte).

Il ne s’agit **pas** d’une automatisation de navigateur. Pour les sites riches en JavaScript ou nécessitant une connexion, utilisez l’[outil Navigateur](/tools/browser).

## Fonctionnement

- `web_search` appelle le fournisseur configuré et renvoie les résultats.
  - **Brave** (par défaut) : renvoie des résultats structurés (titre, URL, extrait).
  - **Perplexity** : renvoie des réponses synthétisées par IA avec des citations issues de recherches web en temps réel.
- Les résultats sont mis en cache par requête pendant 15 minutes (configurable).
- `web_fetch` effectue un simple GET HTTP et extrait le contenu lisible
  (HTML → markdown/texte). Il n’exécute **pas** JavaScript.
- `web_fetch` est activé par défaut (sauf désactivation explicite).

## Choisir un fournisseur de recherche

| Fournisseur                               | Avantages                                       | Cons                                       | Clé API                                      |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| **Brave** (par défaut) | Rapide, résultats structurés, offre gratuite    | Résultats de recherche traditionnels       | `BRAVE_API_KEY`                              |
| **Perplexity**                            | Réponses IA synthétisées, citations, temps réel | Nécessite l’accès Perplexity ou OpenRouter | `OPENROUTER_API_KEY` ou `PERPLEXITY_API_KEY` |

Voir [Configuration de Brave Search](/brave-search) et [Perplexity Sonar](/perplexity) pour des détails spécifiques à chaque fournisseur.

Définissez le fournisseur dans la configuration :

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Exemple : passer à Perplexity Sonar (API directe) :

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

## Obtenir une clé API Brave

1. Créez un compte API Brave Search sur https://brave.com/search/api/
2. Dans le tableau de bord, choisissez le plan **Data for Search** (et non « Data for AI ») et générez une clé API.
3. Exécutez `openclaw configure --section web` pour stocker la clé dans la configuration (recommandé), ou définissez `BRAVE_API_KEY` dans votre environnement.

Brave propose une offre gratuite ainsi que des plans payants ; consultez le portail API Brave pour connaître les limites et la tarification actuelles.

### Où définir la clé (recommandé)

**Recommandé :** exécutez `openclaw configure --section web`. La clé est stockée dans
`~/.openclaw/openclaw.json` sous `tools.web.search.apiKey`.

**Alternative via l’environnement :** définissez `BRAVE_API_KEY` dans l’environnement du processus Gateway (passerelle). Pour une installation Gateway, placez-la dans `~/.openclaw/.env` (ou dans l’environnement de votre service). Voir [Variables d’environnement](/help/faq#how-does-openclaw-load-environment-variables).

## Utiliser Perplexity (direct ou via OpenRouter)

Les modèles Perplexity Sonar disposent de capacités de recherche web intégrées et renvoient des réponses synthétisées par IA avec des citations. Vous pouvez les utiliser via OpenRouter (aucune carte bancaire requise — prise en charge des paiements crypto/prépayés).

### Obtenir une clé API OpenRouter

1. Créez un compte sur https://openrouter.ai/
2. Ajoutez des crédits (crypto, prépayé ou carte bancaire)
3. Générez une clé API dans les paramètres de votre compte

### Configurer la recherche Perplexity

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Alternative via l’environnement :** définissez `OPENROUTER_API_KEY` ou `PERPLEXITY_API_KEY` dans l’environnement du Gateway (passerelle). Pour une installation Gateway, placez-la dans `~/.openclaw/.env`.

Si aucune URL de base n’est définie, OpenClaw choisit une valeur par défaut en fonction de la source de la clé API :

- `PERPLEXITY_API_KEY` ou `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` ou `sk-or-...` → `https://openrouter.ai/api/v1`
- Formats de clé inconnus → OpenRouter (solution de repli sûre)

### Modèles Perplexity disponibles

| Modèle                                                 | Description                                   | Idéal pour            |
| ------------------------------------------------------ | --------------------------------------------- | --------------------- |
| `perplexity/sonar`                                     | Questions-réponses rapides avec recherche web | Consultations rapides |
| `perplexity/sonar-pro` (par défaut) | Raisonnement multi-étapes avec recherche web  | Questions complexes   |
| `perplexity/sonar-reasoning-pro`                       | Analyse de type « chain-of-thought »          | Recherche approfondie |

## web_search

Recherche sur le web à l’aide du fournisseur configuré.

### Prérequis

- `tools.web.search.enabled` ne doit pas être `false` (par défaut : activé)
- Clé API pour le fournisseur choisi :
  - **Brave** : `BRAVE_API_KEY` ou `tools.web.search.apiKey`
  - **Perplexity** : `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` ou `tools.web.search.perplexity.apiKey`

### Configuration

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Paramètres de l'outil

- `query` (requis)
- `count` (1–10 ; valeur par défaut issue de la configuration)
- `country` (optionnel) : code pays à 2 lettres pour des résultats régionaux (ex. : « DE », « US », « ALL »). S’il est omis, Brave choisit sa région par défaut.
- `search_lang` (optionnel) : code de langue ISO pour les résultats de recherche (ex. : « de », « en », « fr »)
- `ui_lang` (optionnel) : code de langue ISO pour les éléments d’interface
- `freshness` (optionnel, Brave uniquement) : filtrer par date de découverte (`pd`, `pw`, `pm`, `py` ou `YYYY-MM-DDtoYYYY-MM-DD`)

**Exemples :**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Récupère une URL et extrait le contenu lisible.

### exigences web_fetch

- `tools.web.fetch.enabled` ne doit pas être `false` (par défaut : activé)
- Solution de repli Firecrawl optionnelle : définir `tools.web.fetch.firecrawl.apiKey` ou `FIRECRAWL_API_KEY`.

### config web_fetch

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### Paramètres de l'outil web_fetch

- `url` (requis, http/https uniquement)
- `extractMode` (`markdown` | `text`)
- `maxChars` (tronque les pages longues)

Notes :

- `web_fetch` utilise d’abord Readability (extraction du contenu principal), puis Firecrawl (si configuré). Si les deux échouent, l’outil renvoie une erreur.
- Les requêtes Firecrawl utilisent un mode de contournement des protections anti-bots et mettent les résultats en cache par défaut.
- `web_fetch` envoie par défaut un User-Agent de type Chrome et `Accept-Language` ; remplacez `userAgent` si nécessaire.
- `web_fetch` bloque les noms d’hôte privés/internes et revérifie les redirections (limitez avec `maxRedirects`).
- `maxChars` est plafonné à `tools.web.fetch.maxCharsCap`.
- `web_fetch` correspond à une extraction « best-effort » ; certains sites nécessiteront l’outil navigateur.
- Voir [Firecrawl](/tools/firecrawl) pour la configuration des clés et les détails du service.
- Les réponses sont mises en cache (15 minutes par défaut) afin de réduire les récupérations répétées.
- Si vous utilisez des profils d’outils/listes d’autorisation, ajoutez `web_search`/`web_fetch` ou `group:web`.
- Si la clé Brave est manquante, `web_search` renvoie une courte indication de configuration avec un lien vers la documentation.
