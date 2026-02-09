---
summary: "Auditer ce qui peut depenser de l'argent, quelles cles sont utilisees et comment afficher l'utilisation"
read_when:
  - Vous souhaitez comprendre quelles fonctionnalites peuvent appeler des API payantes
  - Vous devez auditer les cles, les couts et la visibilite de l'utilisation
  - Vous expliquez le reporting des couts via /status ou /usage
title: "Utilisation des API et couts"
---

# Utilisation des API et couts

Ce document liste les **fonctionnalites pouvant invoquer des cles API** et indique ou leurs couts apparaissent. Il se concentre sur les fonctionnalites d’OpenClaw susceptibles de generer une utilisation chez les fournisseurs ou des appels d’API payants.

## Ou les couts apparaissent (chat + CLI)

**Instantane de cout par session**

- `/status` affiche le modele de la session courante, l’utilisation du contexte et les jetons de la derniere reponse.
- Si le modele utilise une **authentification par cle API**, `/status` affiche egalement le **cout estime** pour la derniere reponse.

**Pied de page de cout par message**

- `/usage full` ajoute un pied de page d’utilisation a chaque reponse, incluant le **cout estime** (cle API uniquement).
- `/usage tokens` affiche uniquement les jetons ; les flux OAuth masquent le cout en dollars.

**Fenetre d’utilisation CLI (quotas fournisseur)**

- `openclaw status --usage` et `openclaw channels list` affichent les **fenetres d’utilisation** du fournisseur
  (instantanes de quotas, pas des couts par message).

Voir [Token use & costs](/token-use) pour plus de details et des exemples.

## Comment les cles sont decouvertes

OpenClaw peut recuperer des identifiants depuis :

- **Profils d’authentification** (par agent, stockes dans `auth-profiles.json`).
- **Variables d’environnement** (p. ex. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Configuration** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) qui peuvent exporter des cles vers l’environnement du processus du skill.

## Fonctionnalités pouvant dépenser des clés

### 1. Reponses du modele principal (chat + outils)

Chaque reponse ou appel d’outil utilise le **fournisseur de modele courant** (OpenAI, Anthropic, etc.). C’est la principale source d’utilisation et de cout.

Voir [Models](/providers/models) pour la configuration de la tarification et [Token use & costs](/token-use) pour l’affichage.

### 2. Compréhension des medias (audio/image/video)

Les medias entrants peuvent etre resumes/transcrits avant l’execution de la reponse. Cela utilise les API des modeles/fournisseurs.

- Audio : OpenAI / Groq / Deepgram (desormais **active automatiquement** lorsque des cles existent).
- Image : OpenAI / Anthropic / Google.
- Video : Google.

Voir [Media understanding](/nodes/media-understanding).

### 3. Embeddings de memoire + recherche semantique

La recherche semantique de la memoire utilise des **API d’embeddings** lorsqu’elle est configuree pour des fournisseurs distants :

- `memorySearch.provider = "openai"` → embeddings OpenAI
- `memorySearch.provider = "gemini"` → embeddings Gemini
- `memorySearch.provider = "voyage"` → Intégrer le voyage
- Optionnel de retour à un fournisseur distant si les embeddings locaux échouent

Vous pouvez rester en local avec `memorySearch.provider = "local"` (aucune utilisation d’API).

Voir [Memory](/concepts/memory).

### 4. Outil de recherche web (Brave / Perplexity via OpenRouter)

`web_search` utilise des cles API et peut entrainer des frais d’utilisation :

- **Brave Search API** : `BRAVE_API_KEY` ou `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter) : `PERPLEXITY_API_KEY` ou `OPENROUTER_API_KEY`

**Palier gratuit Brave (genereux) :**

- **2 000 requetes/mois**
- **1 requete/seconde**
- **Carte bancaire requise** pour la verification (aucun debit sauf mise a niveau)

Voir [Web tools](/tools/web).

### 5. Outil de recuperation web (Firecrawl)

`web_fetch` peut appeler **Firecrawl** lorsqu’une cle API est presente :

- `FIRECRAWL_API_KEY` ou `tools.web.fetch.firecrawl.apiKey`

Si Firecrawl n’est pas configure, l’outil bascule vers une recuperation directe + lisibilite (aucune API payante).

Voir [Web tools](/tools/web).

### 6. Instantanes d’utilisation fournisseur (statut/sante)

Certaines commandes de statut appellent des **endpoints d’utilisation des fournisseurs** pour afficher des fenetres de quotas ou l’etat de l’authentification.
Il s’agit generalement d’appels a faible volume, mais ils touchent tout de meme les API des fournisseurs :

- `openclaw status --usage`
- `openclaw models status --json`

Voir [Models CLI](/cli/models).

### 7. Resume de sauvegarde de compaction

La sauvegarde de compaction peut resumer l’historique de session a l’aide du **modele courant**, ce qui invoque les API des fournisseurs lorsqu’elle s’execute.

Voir [Session management + compaction](/reference/session-management-compaction).

### 8. Analyse / sondage de modele

`openclaw models scan` peut sonder des modeles OpenRouter et utilise `OPENROUTER_API_KEY` lorsque
le sondage est active.

Voir [Models CLI](/cli/models).

### 9. Talk (parole)

Le mode Talk peut invoquer **ElevenLabs** lorsqu’il est configure :

- `ELEVENLABS_API_KEY` ou `talk.apiKey`

Voir [Talk mode](/nodes/talk).

### 10. Skills (API tierces)

Les Skills peuvent stocker `apiKey` dans `skills.entries.<name>.apiKey`. Si un skill utilise cette cle pour des API externes, cela peut entrainer des couts selon le fournisseur du skill.

Voir [Skills](/tools/skills).
