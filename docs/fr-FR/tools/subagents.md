---
summary: "Sub-agents : spawner runs agent isolés qui annoncent résultats back vers chat requester"
read_when:
  - Vous voulez travail background/parallèle via agent
  - Vous changez sessions_spawn ou politique tool sub-agent
title: "Sub-Agents"
---

# Sub-Agents

Sub-agents sont runs agent background spawnés depuis run agent existant. Ils tournent dans propre session (`agent:<agentId>:subagent:<uuid>`) et, quand finis, **annoncent** leur résultat back vers canal chat requester.

## Commande slash

Utilisez `/subagents` pour inspecter ou contrôler runs sub-agent pour **session actuelle** :

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` affiche metadata run (statut, timestamps, id session, path transcript, cleanup).

Goals primaires :

- Paralléliser travail "research / tâche longue / tool lent" sans bloquer run principal.
- Garder sub-agents isolés par défaut (séparation session + sandboxing optionnel).
- Garder surface tool dur à mal utiliser : sub-agents n'obtiennent **pas** tools session par défaut.
- Supporter profondeur nesting configurable pour patterns orchestrator.

Note coût : chaque sub-agent a **propre** contexte et usage token. Pour tâches lourdes ou répétitives, définissez modèle moins cher pour sub-agents et gardez agent principal sur modèle qualité supérieure. Vous pouvez configurer via `agents.defaults.subagents.model` ou overrides per-agent.

## Tool

Utilisez `sessions_spawn` :

- Démarre run sub-agent (`deliver: false`, lane globale : `subagent`)
- Puis exécute étape announce et poste réponse announce vers canal chat requester
- Modèle défaut : hérite caller sauf si vous définissez `agents.defaults.subagents.model` (ou per-agent `agents.list[].subagents.model`) ; `sessions_spawn.model` explicite gagne toujours.
- Thinking défaut : hérite caller sauf si vous définissez `agents.defaults.subagents.thinking` (ou per-agent `agents.list[].subagents.thinking`) ; `sessions_spawn.thinking` explicite gagne toujours.

Params tool :

- `task` (requis)
- `label?` (optionnel)
- `agentId?` (optionnel ; spawner sous autre id agent si autorisé)
- `model?` (optionnel ; override modèle sub-agent ; valeurs invalides skippées et sub-agent tourne sur modèle défaut avec warning dans résultat tool)
- `thinking?` (optionnel ; override niveau thinking pour run sub-agent)
- `runTimeoutSeconds?` (défaut `0` ; quand défini, run sub-agent aborté après N secondes)
- `cleanup?` (`delete|keep`, défaut `keep`)

Allowlist :

- `agents.list[].subagents.allowAgents` : liste ids agent pouvant être ciblés via `agentId` (`["*"]` pour autoriser any). Défaut : seulement agent requester.

Discovery :

- Utilisez `agents_list` pour voir quels ids agent actuellement autorisés pour `sessions_spawn`.

Auto-archive :

- Sessions sub-agent automatiquement archivées après `agents.defaults.subagents.archiveAfterMinutes` (défaut : 60).
- Archive utilise `sessions.delete` et renomme transcript vers `*.deleted.<timestamp>` (même dossier).
- `cleanup: "delete"` archive immédiatement après announce (garde toujours transcript via rename).
- Auto-archive best-effort ; timers pending perdus si passerelle redémarre.
- `runTimeoutSeconds` n'auto-archive **pas** ; seulement stoppe run. Session reste jusqu'à auto-archive.
- Auto-archive s'applique également aux sessions depth-1 et depth-2.

## Sub-Agents Nestés

Par défaut, sub-agents ne peuvent spawner propres sub-agents (`maxSpawnDepth: 1`). Vous pouvez activer un niveau nesting en définissant `maxSpawnDepth: 2`, qui autorise **pattern orchestrator** : main → sub-agent orchestrator → sub-sub-agents worker.

### Comment activer

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // autoriser sub-agents spawner enfants (défaut: 1)
        maxChildrenPerAgent: 5, // max enfants actifs per session agent (défaut: 5)
        maxConcurrent: 8, // cap lane concurrence globale (défaut: 8)
      },
    },
  },
}
```

### Niveaux depth

| Depth | Forme clé session                            | Rôle                                            | Peut spawner?                     |
| ----- | -------------------------------------------- | ----------------------------------------------- | --------------------------------- |
| 0     | `agent:<id>:main`                            | Agent principal                                 | Toujours                          |
| 1     | `agent:<id>:subagent:<uuid>`                 | Sub-agent (orchestrator quand depth 2 autorisé) | Seulement si `maxSpawnDepth >= 2` |
| 2     | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | Sub-sub-agent (worker leaf)                     | Jamais                            |

### Chaîne announce

Résultats flow back remontent chaîne :

1. Worker depth-2 finit → annonce vers parent (orchestrator depth-1)
2. Orchestrator depth-1 reçoit announce, synthétise résultats, finit → annonce vers main
3. Agent main reçoit announce et délivre vers user

Chaque niveau voit seulement announces depuis enfants directs.

### Politique tool par depth

- **Depth 1 (orchestrator, quand `maxSpawnDepth >= 2`)** : Obtient `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history` pour gérer enfants. Autres tools session/system restent denied.
- **Depth 1 (leaf, quand `maxSpawnDepth == 1`)** : Aucun tool session (comportement défaut actuel).
- **Depth 2 (worker leaf)** : Aucun tool session — `sessions_spawn` toujours denied à depth 2. Ne peut spawner enfants ultérieurs.

### Limite spawn per-agent

Chaque session agent (à n'importe quel depth) peut avoir au plus `maxChildrenPerAgent` (défaut : 5) enfants actifs simultanément. Empêche fan-out emballé depuis orchestrator unique.

### Stop cascade

Stopper orchestrator depth-1 stoppe automatiquement tous enfants depth-2 :

- `/stop` dans chat main stoppe tous agents depth-1 et cascade vers enfants depth-2.
- `/subagents kill <id>` stoppe sub-agent spécifique et cascade vers enfants.
- `/subagents kill all` stoppe tous sub-agents pour requester et cascade.

## Authentication

Auth sub-agent résolue par **id agent**, pas type session :

- Clé session sub-agent est `agent:<agentId>:subagent:<uuid>`.
- Store auth chargé depuis `agentDir` de cet agent.
- Profils auth agent principal mergés comme **fallback** ; profils agent overrident profils main sur conflits.

Note : merge additif, profils main toujours disponibles comme fallbacks. Auth complètement isolé per agent pas encore supporté.

## Announce

Sub-agents reportent back via étape announce :

- Étape announce tourne dans session sub-agent (pas session requester).
- Si sub-agent répond exactement `ANNOUNCE_SKIP`, rien posté.
- Sinon réponse announce postée vers canal chat requester via appel `agent` follow-up (`deliver=true`).
- Réponses announce préservent routing thread/topic quand disponible (threads Slack, topics Telegram, threads Matrix).
- Messages announce normalisés vers template stable :
  - `Status:` dérivé depuis outcome run (`success`, `error`, `timeout` ou `unknown`).
  - `Result:` contenu résumé depuis étape announce (ou `(not available)` si manquant).
  - `Notes:` détails erreur et autre contexte utile.
- `Status` pas inféré depuis output modèle ; vient signaux outcome runtime.

## Exemples

**Research parallèle :**

```json
{
  "task": "Rechercher impact changement climatique sur agriculture européenne",
  "label": "Research climat",
  "thinking": "medium"
}
```

**Orchestrator avec workers :**

```json5
{
  task: "Analyser et optimiser ce codebase",
  label: "Orchestrator",
  agentId: "orchestrator",
  model: "claude-sonnet-4.5",
}
```

Voir aussi :

- [Sessions](/fr-FR/concepts/session)
- [Boucle Agent](/fr-FR/concepts/agent-loop)
- [Sandboxing](/fr-FR/gateway/sandboxing)
