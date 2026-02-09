---
summary: "Sous-agents : lancement d’exécutions d’agents isolées qui annoncent les résultats au chat demandeur"
read_when:
  - Vous souhaitez un travail en arrière-plan/parallèle via l’agent
  - Vous modifiez la politique sessions_spawn ou l’outil de sous-agent
title: "Sous-agents"
---

# Sous-agents

Les sous-agents sont des exécutions d’agents en arrière-plan lancées à partir d’une exécution d’agent existante. Ils s’exécutent dans leur propre session (`agent:<agentId>:subagent:<uuid>`) et, une fois terminés, **annoncent** leur résultat au canal de chat du demandeur.

## Commande slash

Utilisez `/subagents` pour inspecter ou contrôler les exécutions de sous-agents pour la **session actuelle** :

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` affiche les métadonnées d’exécution (statut, horodatages, identifiant de session, chemin de la transcription, nettoyage).

Objectifs principaux :

- Paralléliser le travail de « recherche / tâche longue / outil lent » sans bloquer l’exécution principale.
- Garder les sous-agents isolés par défaut (séparation des sessions + sandboxing optionnel).
- Rendre la surface des outils difficile à utiliser à mauvais escient : les sous-agents n’obtiennent **pas** les outils de session par défaut.
- Éviter l’éventail imbriqué : les sous-agents ne peuvent pas lancer de sous-agents.

Note sur les coûts : chaque sous-agent possède **son propre** contexte et sa propre consommation de tokens. Pour les tâches lourdes ou répétitives, définissez un modèle moins coûteux pour les sous-agents et conservez votre agent principal sur un modèle de meilleure qualité.
Vous pouvez configurer cela via `agents.defaults.subagents.model` ou via des surcharges par agent.

## Outil

Utilisez `sessions_spawn` :

- Démarre une exécution de sous-agent (`deliver: false`, voie globale : `subagent`)
- Puis exécute une étape d’annonce et publie la réponse d’annonce dans le canal de chat du demandeur
- Modèle par défaut : hérite de l’appelant, sauf si vous définissez `agents.defaults.subagents.model` (ou par agent `agents.list[].subagents.model`) ; un `sessions_spawn.model` explicite prévaut toujours.
- Raisonnement par défaut : hérite de l’appelant, sauf si vous définissez `agents.defaults.subagents.thinking` (ou par agent `agents.list[].subagents.thinking`) ; un `sessions_spawn.thinking` explicite prévaut toujours.

Tool params:

- `task` (requis)
- `label?` (optionnel)
- `agentId?` (optionnel ; lancer sous un autre identifiant d’agent si autorisé)
- `model?` (optionnel ; remplace le modèle du sous-agent ; les valeurs invalides sont ignorées et le sous-agent s’exécute sur le modèle par défaut avec un avertissement dans le résultat de l’outil)
- `thinking?` (optionnel ; remplace le niveau de raisonnement pour l’exécution du sous-agent)
- `runTimeoutSeconds?` (par défaut `0` ; lorsqu’il est défini, l’exécution du sous-agent est interrompue après N secondes)
- `cleanup?` (`delete|keep`, par défaut `keep`)

Liste d’autorisation :

- `agents.list[].subagents.allowAgents` : liste des identifiants d’agents pouvant être ciblés via `agentId` (`["*"]` pour autoriser tous). Par défaut : uniquement l’agent demandeur.

Découverte :

- Utilisez `agents_list` pour voir quels identifiants d’agents sont actuellement autorisés pour `sessions_spawn`.

Archivage automatique :

- Les sessions de sous-agents sont automatiquement archivées après `agents.defaults.subagents.archiveAfterMinutes` (par défaut : 60).
- L’archivage utilise `sessions.delete` et renomme la transcription en `*.deleted.<timestamp>` (même dossier).
- `cleanup: "delete"` archive immédiatement après l’annonce (tout en conservant la transcription via le renommage).
- L’archivage automatique est réalisé au mieux ; les minuteurs en attente sont perdus si la Gateway (passerelle) redémarre.
- `runTimeoutSeconds` n’archive **pas** automatiquement ; il se contente d’arrêter l’exécution. La session demeure jusqu’à l’archivage automatique.

## Authentification

L’authentification des sous-agents est résolue par **identifiant d’agent**, et non par type de session :

- La clé de session du sous-agent est `agent:<agentId>:subagent:<uuid>`.
- Le magasin d’authentification est chargé depuis `agentDir` de cet agent.
- Les profils d’authentification de l’agent principal sont fusionnés comme **solution de repli** ; les profils de l’agent priment sur ceux du principal en cas de conflit.

Remarque : la fusion est additive, donc les profils du principal sont toujours disponibles comme solutions de repli. Une authentification entièrement isolée par agent n’est pas encore prise en charge.

## Annonce

Les sous-agents rendent compte via une étape d’annonce :

- L’étape d’annonce s’exécute dans la session du sous-agent (et non dans la session du demandeur).
- Si le sous-agent répond exactement `ANNOUNCE_SKIP`, rien n’est publié.
- Sinon, la réponse d’annonce est publiée dans le canal de chat du demandeur via un appel de suivi `agent` (`deliver=true`).
- Les réponses d’annonce conservent l’acheminement par fil/sujet lorsque disponible (fils Slack, sujets Telegram, fils Matrix).
- Les messages d’annonce sont normalisés selon un modèle stable :
  - `Status:` dérivé du résultat de l’exécution (`success`, `error`, `timeout` ou `unknown`).
  - `Result:` le contenu de résumé de l’étape d’annonce (ou `(not available)` s’il est manquant).
  - `Notes:` détails d’erreur et autre contexte utile.
- `Status` n’est pas inféré à partir de la sortie du modèle ; il provient des signaux de résultat à l’exécution.

Les charges utiles d’annonce incluent une ligne de statistiques à la fin (même lorsqu’elles sont encapsulées) :

- Durée d’exécution (p. ex., `runtime 5m12s`)
- Consommation de tokens (entrée/sortie/total)
- Coût estimé lorsque la tarification du modèle est configurée (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` et chemin de la transcription (afin que l’agent principal puisse récupérer l’historique via `sessions_history` ou inspecter le fichier sur le disque)

## Politique d’outils (outils de sous-agent)

Par défaut, les sous-agents obtiennent **tous les outils sauf les outils de session** :

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Remplacement via la configuration :

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Concurrence

Les sous-agents utilisent une voie de file d’attente dédiée en processus :

- Nom de la voie : `subagent`
- Concurrence : `agents.defaults.subagents.maxConcurrent` (par défaut `8`)

## Arrêt

- L’envoi de `/stop` dans le chat du demandeur interrompt la session du demandeur et arrête toute exécution active de sous-agent lancée depuis celle-ci.

## Limitations

- L’annonce des sous-agents est réalisée **au mieux**. Si la Gateway (passerelle) redémarre, les travaux « d’annonce de retour » en attente sont perdus.
- Les sous-agents partagent toujours les mêmes ressources de processus de la Gateway (passerelle) ; considérez `maxConcurrent` comme une soupape de sécurité.
- `sessions_spawn` est toujours non bloquant : il renvoie immédiatement `{ status: "accepted", runId, childSessionKey }`.
- Le contexte du sous-agent n’injecte que `AGENTS.md` + `TOOLS.md` (pas de `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` ni `BOOTSTRAP.md`).
