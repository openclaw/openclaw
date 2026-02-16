---
summary: "Audit ce qui peut dépenser argent, quelles clés utilisées et comment voir usage"
read_when:
  - Vous voulez comprendre quelles fonctionnalités peuvent appeler APIs payées
  - Vous devez auditer clés, coûts et visibilité usage
  - Vous expliquez reporting coût /status ou /usage
title: "Usage API et Coûts"
---

# Usage API & Coûts

Ce doc liste **fonctionnalités qui peuvent invoquer clés API** et où leurs coûts apparaissent. Il se concentre sur fonctionnalités OpenClaw qui peuvent générer usage provider ou appels API payés.

## Où coûts apparaissent (chat + CLI)

**Snapshot coût per-session**

- `/status` montre modèle session actuel, usage contexte et derniers tokens réponse.
- Si modèle utilise **auth API-key**, `/status` montre aussi **coût estimé** pour dernière réponse.

**Footer coût per-message**

- `/usage full` append footer usage à chaque réponse, incluant **coût estimé** (API-key uniquement).
- `/usage tokens` montre tokens uniquement ; flux OAuth cachent coût dollar.

**Fenêtres usage CLI (quotas provider)**

- `openclaw status --usage` et `openclaw channels list` montrent **fenêtres usage** provider (snapshots quota, pas coûts per-message).

Voir [Utilisation token & coûts](/fr-FR/reference/token-use) pour détails et exemples.

## Comment clés découvertes

OpenClaw peut récupérer credentials depuis :

- **Profils Auth** (per-agent, stockés dans `auth-profiles.json`).
- **Variables environnement** (e.g. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`, `memorySearch.*`, `talk.apiKey`).
- **Compétences** (`skills.entries.<name>.apiKey`) qui peuvent exporter clés vers env processus compétence.

## Fonctionnalités qui peuvent dépenser clés

### 1) Réponses modèle core (chat + outils)

Chaque réponse ou appel outil utilise **provider modèle actuel** (OpenAI, Anthropic, etc). C'est source primaire usage et coût.

Voir [Modèles](/fr-FR/providers/models) pour config prix et [Utilisation token & coûts](/fr-FR/reference/token-use) pour affichage.

### 2) Compréhension média (audio/image/video)

Média entrant peut être résumé/transcrit avant exécution réponse. Utilise APIs modèle/provider.

- Audio : OpenAI / Groq / Deepgram (maintenant **auto-activé** quand clés existent).
- Image : OpenAI / Anthropic / Google.
- Video : Google.

### 3) Recherche web (Brave Search)

- Config : `tools.web.search.brave.apiKey` ou `BRAVE_API_KEY`.
- Usage : chaque requête web search consomme 1+ appel API Brave.

### 4) Fetch web (Firecrawl)

- Config : `tools.web.fetch.firecrawl.apiKey` ou `FIRECRAWL_API_KEY`.
- Usage : scraping web pages via Firecrawl.

### 5) Recherche mémoire (embeddings OpenAI)

- Config : `memorySearch.provider: "openai"` + `OPENAI_API_KEY`.
- Usage : génération embeddings pour recherche mémoire sémantique.

Voir aussi :

- [Modèles](/fr-FR/providers/models)
- [Utilisation Token](/fr-FR/reference/token-use)
- [Configuration](/fr-FR/cli/config)
