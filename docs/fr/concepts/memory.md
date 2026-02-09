---
summary: "Comment fonctionne la mémoire d’OpenClaw (fichiers d’espace de travail + purge automatique de la mémoire)"
read_when:
  - Vous voulez la disposition des fichiers de mémoire et le flux de travail
  - Vous voulez ajuster la purge automatique de la mémoire avant la compaction
---

# Mémoire

La mémoire d’OpenClaw est du **Markdown brut dans l’espace de travail de l’agent**. Les fichiers sont la
source de vérité ; le modèle ne « se souvient » que de ce qui est écrit sur le disque.

Les outils de recherche de mémoire sont fournis par le plugin de mémoire actif (par défaut :
`memory-core`). Désactivez les plugins de mémoire avec `plugins.slots.memory = "none"`.

## Fichiers de mémoire (Markdown)

La disposition par défaut de l’espace de travail utilise deux couches de mémoire :

- `memory/YYYY-MM-DD.md`
  - Journal quotidien (ajout uniquement).
  - Lecture d’aujourd’hui + hier au démarrage de la session.
- `MEMORY.md` (facultatif)
  - Mémoire à long terme curatée.
  - **Chargée uniquement dans la session principale et privée** (jamais dans des contextes de groupe).

Ces fichiers se trouvent sous l’espace de travail (`agents.defaults.workspace`, par défaut
`~/.openclaw/workspace`). Voir [Espace de travail de l’agent](/concepts/agent-workspace) pour la disposition complète.

## Quand écrire en mémoire

- Les décisions, préférences et faits durables vont dans `MEMORY.md`.
- Les notes quotidiennes et le contexte courant vont dans `memory/YYYY-MM-DD.md`.
- Si quelqu’un dit « souviens‑toi de ceci », écrivez‑le (ne le gardez pas en RAM).
- Cette zone évolue encore. Il est utile de rappeler au modèle de stocker des souvenirs ; il saura quoi faire.
- Si vous voulez que quelque chose persiste, **demandez au bot de l’écrire** en mémoire.

## Purge automatique de la mémoire (ping avant compaction)

Lorsqu’une session est **proche de l’auto‑compaction**, OpenClaw déclenche un **tour agentique silencieux**
qui rappelle au modèle d’écrire la mémoire durable **avant** que le contexte ne soit compacté. Les invites
par défaut indiquent explicitement que le modèle _peut répondre_, mais en général `NO_REPLY` est la
réponse correcte afin que l’utilisateur ne voie jamais ce tour.

Ceci est contrôlé par `agents.defaults.compaction.memoryFlush` :

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Détails :

- **Seuil souple** : la purge se déclenche lorsque l’estimation des tokens de session dépasse
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Silencieux** par défaut : les invites incluent `NO_REPLY` afin que rien ne soit livré.
- **Deux invites** : une invite utilisateur plus une invite système ajoutent le rappel.
- **Une purge par cycle de compaction** (suivie dans `sessions.json`).
- **L’espace de travail doit être accessible en écriture** : si la session s’exécute en sandbox avec
  `workspaceAccess: "ro"` ou `"none"`, la purge est ignorée.

Pour le cycle de vie complet de la compaction, voir
[Gestion des sessions + compaction](/reference/session-management-compaction).

## Recherche de mémoire vectorielle

OpenClaw peut construire un petit index vectoriel sur `MEMORY.md` et `memory/*.md` afin que
les requêtes sémantiques trouvent des notes liées même lorsque le libellé diffère.

Valeurs par défaut :

- Activée par défaut.
- Surveille les fichiers de mémoire pour les changements (avec anti‑rebond).
- Utilise des embeddings distants par défaut. Si `memorySearch.provider` n’est pas défini, OpenClaw sélectionne automatiquement :
  1. `local` si un `memorySearch.local.modelPath` est configuré et que le fichier existe.
  2. `openai` si une clé OpenAI peut être résolue.
  3. `gemini` si une clé Gemini peut être résolue.
  4. `voyage` si une clé Voyage peut être résolue.
  5. Sinon, la recherche mémoire reste désactivée jusqu’à configuration.
- Le mode local utilise node-llama-cpp et peut nécessiter `pnpm approve-builds`.
- Utilise sqlite-vec (lorsqu’il est disponible) pour accélérer la recherche vectorielle dans SQLite.

Les embeddings distants **nécessitent** une clé API pour le fournisseur d’embeddings. OpenClaw
résout les clés depuis les profils d’authentification, `models.providers.*.apiKey`, ou les variables
d’environnement. L’OAuth Codex couvre uniquement le chat/les complétions et **ne** satisfait **pas**
les embeddings pour la recherche mémoire. Pour Gemini, utilisez `GEMINI_API_KEY` ou
`models.providers.google.apiKey`. Pour Voyage, utilisez `VOYAGE_API_KEY` ou
`models.providers.voyage.apiKey`. Lors de l’utilisation d’un endpoint compatible OpenAI personnalisé,
définissez `memorySearch.remote.apiKey` (et éventuellement `memorySearch.remote.headers`).

### Backend QMD (expérimental)

Définissez `memory.backend = "qmd"` pour remplacer l’indexeur SQLite intégré par
[QMD](https://github.com/tobi/qmd) : un sidecar de recherche « local‑first » combinant
BM25 + vecteurs + reranking. Le Markdown reste la source de vérité ; OpenClaw délègue la
récupération à QMD. Points clés :

**Prérequis**

- Désactivé par défaut. Activation par configuration (`memory.backend = "qmd"`).
- Installez le CLI QMD séparément (`bun install -g github.com/tobi/qmd` ou téléchargez
  une version) et assurez‑vous que le binaire `qmd` est sur le `PATH` de la Gateway (passerelle).
- QMD nécessite une version de SQLite autorisant les extensions (`brew install sqlite` sur
  macOS).
- QMD s’exécute entièrement en local via Bun + `node-llama-cpp` et télécharge automatiquement les modèles
  GGUF depuis HuggingFace au premier usage (aucun démon Ollama séparé requis).
- La Gateway exécute QMD dans un home XDG autonome sous
  `~/.openclaw/agents/<agentId>/qmd/` en définissant `XDG_CONFIG_HOME` et
  `XDG_CACHE_HOME`.
- Support des OS : macOS et Linux fonctionnent immédiatement une fois Bun + SQLite
  installés. Windows est mieux pris en charge via WSL2.

**Fonctionnement du sidecar**

- La Gateway écrit un home QMD autonome sous
  `~/.openclaw/agents/<agentId>/qmd/` (configuration + cache + base sqlite).
- Les collections sont réécrites depuis `memory.qmd.paths` (plus les fichiers de mémoire
  par défaut de l’espace de travail) vers `index.yml`, puis `qmd update` + `qmd embed` s’exécutent au démarrage et
  à un intervalle configurable (`memory.qmd.update.interval`, par défaut 5 min).
- L'actualisation du démarrage s'exécute maintenant en arrière-plan par défaut, de sorte que le démarrage du chat n'est pas
  bloqué; définissez `mémoire. md.update.waitForBootSync = true` pour garder le comportement de blocage
  précédent.
- Les recherches s’exécutent via `qmd query --json`. Si QMD échoue ou si le binaire est absent,
  OpenClaw bascule automatiquement vers le gestionnaire SQLite intégré afin que les outils
  de mémoire continuent de fonctionner.
- OpenClaw n'expose pas le réglage de la taille des lots QMD aujourd'hui ; le comportement des lots est
  contrôlé par QMD lui-même.
- **La première recherche peut être lente** : QMD peut télécharger des modèles GGUF locaux
  (reranker/extension de requête) lors de la première exécution de `qmd query`.
  - OpenClaw définit automatiquement `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` lorsqu’il exécute QMD.
  - Si vous souhaitez pré‑télécharger manuellement les modèles (et préchauffer le même index
    qu’OpenClaw utilise), lancez une requête unique avec les répertoires XDG de l’agent.

    L’état QMD d’OpenClaw se trouve dans votre **répertoire d’état** (par défaut `~/.openclaw`).
    Vous pouvez pointer `qmd` vers exactement le même index en exportant les mêmes variables XDG
    qu’OpenClaw utilise :

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Surface de configuration (`memory.qmd.*`)**

- `command` (par défaut `qmd`) : remplacer le chemin de l’exécutable.
- `includeDefaultMemory` (par défaut `true`) : indexation automatique de `MEMORY.md` + `memory/**/*.md`.
- `paths[]` : ajouter des répertoires/fichiers supplémentaires (`path`, optionnel `pattern`, optionnel
  stable `name`).
- `sessions` : activer l’indexation des JSONL de session (`enabled`, `retentionDays`,
  `exportDir`).
- `update` : contrôle la cadence d’actualisation (`interval`, `debounceMs`, `onBoot`, `embedInterval`).
- `limits` : plafonner la charge utile de rappel (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope` : même schéma que [`session.sendPolicy`](/gateway/configuration#session).
  La valeur par défaut est DM‑only (`deny` tout, `allow` discussions directes) ; assouplissez‑la pour faire remonter les résultats QMD dans les groupes/canaux.
- Les extraits provenant de l’extérieur de l’espace de travail apparaissent comme
  `qmd/<collection>/<relative-path>` dans les résultats `memory_search` ; `memory_get`
  comprend ce préfixe et lit depuis la racine de collection QMD configurée.
- Lorsque `memory.qmd.sessions.enabled = true`, OpenClaw exporte des transcriptions de session assainies
  (tours Utilisateur/Assistant) dans une collection QMD dédiée sous
  `~/.openclaw/agents/<id>/qmd/sessions/`, afin que `memory_search` puisse rappeler des
  conversations récentes sans toucher à l’index SQLite intégré.
- Les extraits `memory_search` incluent désormais un pied de page `Source: <path#line>` lorsque
  `memory.citations` est `auto`/`on` ; définissez `memory.citations = "off"` pour conserver
  les métadonnées de chemin en interne (l’agent reçoit toujours le chemin pour
  `memory_get`, mais le texte de l’extrait omet le pied de page et l’invite système
  avertit l’agent de ne pas le citer).

**Exemple**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Citations & repli**

- `memory.citations` s’applique quel que soit le backend (`auto`/`on`/`off`).
- Lorsque `qmd` s’exécute, nous marquons `status().backend = "qmd"` afin que les diagnostics indiquent quel
  moteur a servi les résultats. Si le sous‑processus QMD se termine ou si la sortie JSON ne peut pas être
  analysée, le gestionnaire de recherche consigne un avertissement et renvoie le fournisseur intégré
  (embeddings Markdown existants) jusqu’à ce que QMD récupère.

### Chemins de mémoire supplémentaires

Si vous souhaitez indexer des fichiers Markdown en dehors de la disposition par défaut de l’espace de travail, ajoutez
des chemins explicites :

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Notes :

- Les chemins peuvent être absolus ou relatifs à l’espace de travail.
- Les répertoires sont analysés récursivement pour les fichiers `.md`.
- Seuls les fichiers Markdown sont indexés.
- Les liens symboliques sont ignorés (fichiers ou répertoires).

### Embeddings Gemini (natifs)

Définissez le fournisseur sur `gemini` pour utiliser directement l’API d’embeddings Gemini :

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notes :

- `remote.baseUrl` est optionnel (par défaut l’URL de base de l’API Gemini).
- `remote.headers` permet d’ajouter des en‑têtes supplémentaires si nécessaire.
- Modèle par défaut : `gemini-embedding-001`.

Si vous souhaitez utiliser un **endpoint compatible OpenAI personnalisé** (OpenRouter, vLLM ou un proxy),
vous pouvez utiliser la configuration `remote` avec le fournisseur OpenAI :

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Si vous ne souhaitez pas définir de clé API, utilisez `memorySearch.provider = "local"` ou définissez
`memorySearch.fallback = "none"`.

Replis :

- `memorySearch.fallback` peut être `openai`, `gemini`, `local` ou `none`.
- Le fournisseur de repli n’est utilisé que lorsque le fournisseur d’embeddings principal échoue.

Indexation par lots (OpenAI + Gemini) :

- Activée par défaut pour les embeddings OpenAI et Gemini. Définissez `agents.defaults.memorySearch.remote.batch.enabled = false` pour désactiver.
- Le comportement par défaut attend la fin des lots ; ajustez `remote.batch.wait`, `remote.batch.pollIntervalMs` et `remote.batch.timeoutMinutes` si nécessaire.
- Définissez `remote.batch.concurrency` pour contrôler le nombre de tâches de lot soumises en parallèle (par défaut : 2).
- Le mode lot s’applique lorsque `memorySearch.provider = "openai"` ou `"gemini"` et utilise la clé API correspondante.
- Les lots Gemini utilisent l’endpoint de lot asynchrone des embeddings et nécessitent la disponibilité de l’API Batch Gemini.

Pourquoi le mode batch OpenAI est rapide et économique :

- Pour les remplissages volumineux, OpenAI est généralement l’option la plus rapide que nous prenons en charge, car nous pouvons soumettre de nombreuses requêtes d’embeddings dans un seul lot et laisser OpenAI les traiter de manière asynchrone.
- OpenAI propose une tarification remisée pour les charges de travail de l’API Batch, de sorte que les grandes exécutions d’indexation sont généralement moins chères que l’envoi synchrone des mêmes requêtes.
- Voir la documentation et les tarifs de l’API Batch d’OpenAI pour plus de détails :
  - https://platform.openai.com/docs/api-reference/batch
  - https://platform.openai.com/pricing

Exemple de configuration :

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Outils :

- `memory_search` — renvoie des extraits avec fichier + plages de lignes.
- `memory_get` — lit le contenu d’un fichier de mémoire par chemin.

Mode local :

- Définissez `agents.defaults.memorySearch.provider = "local"`.
- Fournissez `agents.defaults.memorySearch.local.modelPath` (GGUF ou URI `hf:`).
- Optionnel : définissez `agents.defaults.memorySearch.fallback = "none"` pour éviter le repli distant.

### Fonctionnement des outils de mémoire

- `memory_search` effectue une recherche sémantique sur des fragments Markdown (~400 tokens ciblés, chevauchement de 80 tokens) provenant de `MEMORY.md` + `memory/**/*.md`. Il renvoie le texte de l’extrait (plafonné à ~700 caractères), le chemin du fichier, la plage de lignes, le score, le fournisseur/modèle, et indique si nous avons basculé de local → distant pour les embeddings. Aucune charge utile de fichier complet n’est renvoyée.
- `memory_get` lit un fichier Markdown de mémoire spécifique (relatif à l’espace de travail), éventuellement à partir d’une ligne de départ et pour N lignes. Les chemins en dehors de `MEMORY.md` / `memory/` sont rejetés.
- Les deux outils ne sont activés que lorsque `memorySearch.enabled` est vrai pour l’agent.

### Ce qui est indexé (et quand)

- Type de fichier : Markdown uniquement (`MEMORY.md`, `memory/**/*.md`).
- Stockage de l’index : SQLite par agent à `~/.openclaw/memory/<agentId>.sqlite` (configurable via `agents.defaults.memorySearch.store.path`, prend en charge le jeton `{agentId}`).
- Fraîcheur : un observateur sur `MEMORY.md` + `memory/` marque l’index comme obsolète (anti‑rebond 1,5 s). La synchronisation est planifiée au démarrage de la session, lors d’une recherche ou à intervalle, et s’exécute de manière asynchrone. Les transcriptions de session utilisent des seuils delta pour déclencher une synchronisation en arrière‑plan.
- Déclencheurs de réindexation : l’index stocke l’empreinte **fournisseur/modèle d’embedding + endpoint + paramètres de découpage**. Si l’un d’eux change, OpenClaw réinitialise et réindexe automatiquement l’ensemble du stockage.

### Recherche hybride (BM25 + vecteur)

Lorsqu’elle est activée, OpenClaw combine :

- **Similarité vectorielle** (correspondance sémantique, le libellé peut différer)
- **Pertinence par mots‑clés BM25** (tokens exacts comme IDs, variables d’environnement, symboles de code)

Si la recherche plein texte n’est pas disponible sur votre plateforme, OpenClaw se replie sur une recherche vectorielle seule.

#### Pourquoi l’hybride ?

La recherche vectorielle est excellente pour « cela signifie la même chose » :

- « Mac Studio gateway host » vs « la machine exécutant la Gateway (passerelle) »
- « debounce file updates » vs « éviter l’indexation à chaque écriture »

Mais elle peut être faible sur des tokens exacts à fort signal :

- IDs (`a828e60`, `b3b9895a…`)
- symboles de code (`memorySearch.query.hybrid`)
- chaînes d’erreur (« sqlite-vec unavailable »)

BM25 (plein texte) est l’inverse : fort sur les tokens exacts, plus faible sur les paraphrases.
La recherche hybride est le juste milieu pragmatique : **utiliser les deux signaux de récupération** afin d’obtenir
de bons résultats à la fois pour les requêtes en « langage naturel » et les requêtes « aiguille dans une botte de foin ».

#### Comment nous fusionnons les résultats (conception actuelle)

Esquisse d’implémentation :

1. Récupérer un pool de candidats des deux côtés :

- **Vecteur** : top `maxResults * candidateMultiplier` par similarité cosinus.
- **BM25** : top `maxResults * candidateMultiplier` par rang BM25 FTS5 (plus petit est meilleur).

2. Convertir le rang BM25 en un score ~0..1 :

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Unifier les candidats par id de fragment et calculer un score pondéré :

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notes :

- `vectorWeight` + `textWeight` est normalisé à 1,0 lors de la résolution de configuration, afin que les poids se comportent comme des pourcentages.
- Si les embeddings sont indisponibles (ou si le fournisseur renvoie un vecteur nul), nous exécutons quand même BM25 et renvoyons les correspondances par mots‑clés.
- Si FTS5 ne peut pas être créé, nous conservons une recherche vectorielle seule (pas d’échec bloquant).

Ce n’est pas « parfait selon la théorie de l’IR », mais c’est simple, rapide et tend à améliorer le rappel/la précision sur des notes réelles.
Si nous voulons aller plus loin plus tard, les étapes suivantes courantes sont la Fusion par Rang Réciproque (RRF) ou la normalisation des scores
(min/max ou z‑score) avant le mélange.

Configuration :

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

### Cache d’embeddings

OpenClaw peut mettre en cache les **embeddings de fragments** dans SQLite afin que la réindexation et les mises à jour fréquentes (en particulier les transcriptions de session) ne ré‑encodent pas un texte inchangé.

Configuration :

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Recherche de mémoire de session (expérimental)

Vous pouvez optionnellement indexer les **transcriptions de session** et les exposer via `memory_search`.
Ceci est protégé par un indicateur expérimental.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Notes :

- L’indexation des sessions est **optionnelle** (désactivée par défaut).
- Les mises à jour de session sont anti‑rebond et **indexées de manière asynchrone** une fois les seuils delta dépassés (best‑effort).
- `memory_search` ne bloque jamais sur l’indexation ; les résultats peuvent être légèrement obsolètes jusqu’à la fin de la synchronisation en arrière‑plan.
- Les résultats incluent toujours uniquement des extraits ; `memory_get` reste limité aux fichiers de mémoire.
- L’indexation des sessions est isolée par agent (seuls les journaux de session de cet agent sont indexés).
- Les journaux de session résident sur le disque (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Tout processus/utilisateur ayant accès au système de fichiers peut les lire ; considérez donc l’accès disque comme la frontière de confiance. Pour une isolation plus stricte, exécutez les agents sous des utilisateurs ou des hôtes OS distincts.

Seuils delta (valeurs par défaut affichées) :

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### Accélération vectorielle SQLite (sqlite-vec)

Lorsque l’extension sqlite-vec est disponible, OpenClaw stocke les embeddings dans une
table virtuelle SQLite (`vec0`) et effectue les requêtes de distance vectorielle
dans la base de données. Cela maintient des recherches rapides sans charger chaque embedding en JS.

Configuration (facultatif) :

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Notes :

- `enabled` est vrai par défaut ; lorsqu’il est désactivé, la recherche se replie sur
  la similarité cosinus en processus sur les embeddings stockés.
- Si l’extension sqlite-vec est absente ou échoue au chargement, OpenClaw consigne l’erreur
  et continue avec le repli JS (pas de table vectorielle).
- `extensionPath` remplace le chemin sqlite-vec fourni (utile pour des builds personnalisés
  ou des emplacements d’installation non standard).

### Téléchargement automatique des embeddings locaux

- Modèle d’embedding local par défaut : `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 Go).
- Lorsque `memorySearch.provider = "local"`, `node-llama-cpp` résout `modelPath` ; si le GGUF est manquant, il est **téléchargé automatiquement** dans le cache (ou `local.modelCacheDir` s’il est défini), puis chargé. Les téléchargements reprennent lors d’une nouvelle tentative.
- Exigence de build natif : exécutez `pnpm approve-builds`, choisissez `node-llama-cpp`, puis `pnpm rebuild node-llama-cpp`.
- Repli : si la configuration locale échoue et que `memorySearch.fallback = "openai"`, nous basculons automatiquement vers des embeddings distants (`openai/text-embedding-3-small` sauf indication contraire) et enregistrons la raison.

### Exemple d’endpoint compatible OpenAI personnalisé

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Notes :

- `remote.*` a priorité sur `models.providers.openai.*`.
- `remote.headers` se fusionnent avec les en‑têtes OpenAI ; le distant l’emporte en cas de conflit de clés. Omettez `remote.headers` pour utiliser les valeurs par défaut OpenAI.
