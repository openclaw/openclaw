---
title: "Mémoire"
summary: "Comment fonctionne la mémoire d'OpenClaw (fichiers d'espace de travail + vidage automatique de mémoire)"
read_when:
  - Vous voulez la disposition des fichiers de mémoire et le flux de travail
  - Vous voulez ajuster le vidage automatique de mémoire pré-compaction
---

# Mémoire

La mémoire d'OpenClaw est **du Markdown simple dans l'espace de travail de l'agent**. Les fichiers sont la
source de vérité ; le modèle ne "se souvient" que de ce qui est écrit sur disque.

Les outils de recherche de mémoire sont fournis par le plugin de mémoire actif (par défaut :
`memory-core`). Désactivez les plugins de mémoire avec `plugins.slots.memory = "none"`.

## Fichiers de mémoire (Markdown)

La disposition d'espace de travail par défaut utilise deux couches de mémoire :

- `memory/YYYY-MM-DD.md`
  - Journal quotidien (ajout uniquement).
  - Lit aujourd'hui + hier au démarrage de session.
- `MEMORY.md` (optionnel)
  - Mémoire à long terme curée.
  - **Ne charger que dans la session principale, privée** (jamais dans les contextes de groupe).

Ces fichiers vivent sous l'espace de travail (`agents.defaults.workspace`, par défaut
`~/.openclaw/workspace`). Voir [Espace de travail de l'agent](/fr-FR/concepts/agent-workspace) pour la disposition complète.

## Quand écrire la mémoire

- Les décisions, préférences et faits durables vont dans `MEMORY.md`.
- Les notes quotidiennes et le contexte courant vont dans `memory/YYYY-MM-DD.md`.
- Si quelqu'un dit "souviens-toi de ça," écrivez-le (ne le gardez pas en RAM).
- Cette zone est encore en évolution. Ça aide de rappeler au modèle de stocker les mémoires ; il saura quoi faire.
- Si vous voulez que quelque chose reste, **demandez au bot de l'écrire** dans la mémoire.

## Vidage automatique de mémoire (ping pré-compaction)

Quand une session est **proche de l'auto-compaction**, OpenClaw déclenche un **tour
agentique silencieux** qui rappelle au modèle d'écrire de la mémoire durable **avant** que le
contexte ne soit compacté. Les invites par défaut disent explicitement que le modèle _peut répondre_,
mais habituellement `NO_REPLY` est la réponse correcte donc l'utilisateur ne voit jamais ce tour.

Ceci est contrôlé par `agents.defaults.compaction.memoryFlush` :

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session proche de la compaction. Stockez les mémoires durables maintenant.",
          prompt: "Écrivez toutes notes durables dans memory/YYYY-MM-DD.md ; répondez avec NO_REPLY si rien à stocker.",
        },
      },
    },
  },
}
```

Détails :

- **Seuil souple** : le vidage se déclenche quand l'estimation de jetons de session franchit
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Silencieux** par défaut : les invites incluent `NO_REPLY` donc rien n'est livré.
- **Deux invites** : une invite utilisateur plus une invite système ajoutent le rappel.
- **Un vidage par cycle de compaction** (suivi dans `sessions.json`).
- **L'espace de travail doit être accessible en écriture** : si la session s'exécute en sandbox avec
  `workspaceAccess: "ro"` ou `"none"`, le vidage est ignoré.

Pour le cycle de compaction complet, voir
[Gestion de session + compaction](/fr-FR/reference/session-management-compaction).

## Recherche de mémoire vectorielle

OpenClaw peut construire un petit index vectoriel sur `MEMORY.md` et `memory/*.md` afin que
les requêtes sémantiques puissent trouver des notes connexes même quand la formulation diffère.

Valeurs par défaut :

- Activé par défaut.
- Surveille les fichiers de mémoire pour les changements (debounced).
- Configurez la recherche de mémoire sous `agents.defaults.memorySearch` (pas au niveau supérieur
  `memorySearch`).
- Utilise des embeddings distants par défaut. Si `memorySearch.provider` n'est pas défini, OpenClaw auto-sélectionne :
  1. `local` si un `memorySearch.local.modelPath` est configuré et que le fichier existe.
  2. `openai` si une clé OpenAI peut être résolue.
  3. `gemini` si une clé Gemini peut être résolue.
  4. `voyage` si une clé Voyage peut être résolue.
  5. Sinon la recherche de mémoire reste désactivée jusqu'à configuration.
- Le mode local utilise node-llama-cpp et peut nécessiter `pnpm approve-builds`.
- Utilise sqlite-vec (quand disponible) pour accélérer la recherche vectorielle dans SQLite.

Les embeddings distants **requièrent** une clé API pour le fournisseur d'embedding. OpenClaw
résout les clés depuis les profils d'authentification, `models.providers.*.apiKey`, ou les variables
d'environnement. OAuth Codex ne couvre que chat/completions et ne **satisfait pas**
les embeddings pour la recherche de mémoire. Pour Gemini, utilisez `GEMINI_API_KEY` ou
`models.providers.google.apiKey`. Pour Voyage, utilisez `VOYAGE_API_KEY` ou
`models.providers.voyage.apiKey`. Lors de l'utilisation d'un point de terminaison compatible OpenAI personnalisé,
définissez `memorySearch.remote.apiKey` (et `memorySearch.remote.headers` optionnel).

### Backend QMD (expérimental)

Définissez `memory.backend = "qmd"` pour échanger l'indexeur SQLite intégré contre
[QMD](https://github.com/tobi/qmd) : un side-car de recherche local-first qui combine
BM25 + vecteurs + reranking. Le Markdown reste la source de vérité ; OpenClaw shell
vers QMD pour la récupération.

Voir les docs complètes de memory.md pour la configuration QMD détaillée.

### Recherche hybride (BM25 + vecteur)

Quand activée, OpenClaw combine :

- **Similarité vectorielle** (correspondance sémantique, la formulation peut différer)
- **Pertinence de mots-clés BM25** (jetons exacts comme IDs, variables d'env, symboles de code)

Si la recherche full-text n'est pas disponible sur votre plateforme, OpenClaw se rabat sur la recherche vectorielle uniquement.

Config :

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Outils

- `memory_search` — retourne des extraits avec fichier + plages de lignes.
- `memory_get` — lit le contenu de fichier de mémoire par chemin.

Mode local :

- Définissez `agents.defaults.memorySearch.provider = "local"`.
- Fournissez `agents.defaults.memorySearch.local.modelPath` (GGUF ou URI `hf:`).
- Optionnel : définissez `agents.defaults.memorySearch.fallback = "none"` pour éviter le repli distant.
