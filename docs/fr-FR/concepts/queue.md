---
summary: "Conception de file d'attente de commandes qui sérialise les exécutions de réponse automatique entrantes"
read_when:
  - Changer l'exécution de réponse automatique ou la concurrence
title: "File d'attente de commandes"
---

# File d'attente de commandes (2026-01-16)

Nous sérialisons les exécutions de réponse automatique entrantes (tous canaux) via une petite file d'attente en processus pour empêcher plusieurs exécutions d'agent de se heurter, tout en permettant un parallélisme sûr entre sessions.

## Pourquoi

- Les exécutions de réponse automatique peuvent être coûteuses (appels LLM) et peuvent entrer en collision quand plusieurs messages entrants arrivent ensemble.
- Sérialiser évite de rivaliser pour les ressources partagées (fichiers de session, journaux, stdin CLI) et réduit la chance de limites de taux en amont.

## Comment ça fonctionne

- Une file d'attente FIFO consciente des voies draine chaque voie avec un plafond de concurrence configurable (par défaut 1 pour les voies non configurées ; main par défaut à 4, subagent à 8).
- `runEmbeddedPiAgent` met en file d'attente par **clé de session** (voie `session:<key>`) pour garantir une seule exécution active par session.
- Chaque exécution de session est ensuite mise en file d'attente dans une **voie globale** (`main` par défaut) donc le parallélisme global est plafonné par `agents.defaults.maxConcurrent`.
- Quand la journalisation verbose est activée, les exécutions en file d'attente émettent un court avis si elles ont attendu plus de ~2s avant de démarrer.
- Les indicateurs de frappe se déclenchent toujours immédiatement à la mise en file d'attente (quand supporté par le canal) donc l'expérience utilisateur reste inchangée pendant que nous attendons notre tour.

## Modes de file d'attente (par canal)

Les messages entrants peuvent diriger l'exécution actuelle, attendre un tour de suivi ou faire les deux :

- `steer` : injecter immédiatement dans l'exécution actuelle (annule les appels d'outils en attente après la prochaine limite d'outil). Si pas de streaming, repli vers followup.
- `followup` : mettre en file d'attente pour le prochain tour d'agent après la fin de l'exécution actuelle.
- `collect` : fusionner tous les messages en file d'attente en un **seul** tour de suivi (par défaut). Si les messages ciblent différents canaux/fils, ils se drainent individuellement pour préserver le routage.
- `steer-backlog` (alias `steer+backlog`) : diriger maintenant **et** préserver le message pour un tour de suivi.
- `interrupt` (hérité) : abandonner l'exécution active pour cette session, puis exécuter le message le plus récent.
- `queue` (alias hérité) : identique à `steer`.

Steer-backlog signifie que vous pouvez obtenir une réponse de suivi après l'exécution dirigée, donc
les surfaces de streaming peuvent ressembler à des doublons. Préférez `collect`/`steer` si vous voulez
une réponse par message entrant.
Envoyez `/queue collect` comme commande autonome (par session) ou définissez `messages.queue.byChannel.discord: "collect"`.

Valeurs par défaut (quand non défini dans la config) :

- Toutes les surfaces → `collect`

Configurez globalement ou par canal via `messages.queue` :

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Options de file d'attente

Les options s'appliquent à `followup`, `collect` et `steer-backlog` (et à `steer` quand il replie vers followup) :

- `debounceMs` : attendre le calme avant de démarrer un tour de suivi (empêche "continue, continue").
- `cap` : messages max en file d'attente par session.
- `drop` : politique de débordement (`old`, `new`, `summarize`).

Summarize garde une courte liste à puces de messages abandonnés et l'injecte comme invite de suivi synthétique.
Valeurs par défaut : `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Remplacements par session

- Envoyez `/queue <mode>` comme commande autonome pour stocker le mode pour la session actuelle.
- Les options peuvent être combinées : `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` ou `/queue reset` efface le remplacement de session.

## Portée et garanties

- S'applique aux exécutions d'agent de réponse automatique sur tous les canaux entrants qui utilisent le pipeline de réponse de passerelle (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- La voie par défaut (`main`) est à l'échelle du processus pour les entrées + heartbeats principaux ; définissez `agents.defaults.maxConcurrent` pour permettre plusieurs sessions en parallèle.
- Des voies supplémentaires peuvent exister (par ex. `cron`, `subagent`) donc les tâches d'arrière-plan peuvent s'exécuter en parallèle sans bloquer les réponses entrantes.
- Les voies par session garantissent qu'une seule exécution d'agent touche une session donnée à la fois.
- Pas de dépendances externes ou de fils de travail d'arrière-plan ; pur TypeScript + promesses.

## Dépannage

- Si les commandes semblent bloquées, activez les journaux verbose et cherchez les lignes "queued for …ms" pour confirmer que la file d'attente se draine.
- Si vous avez besoin de la profondeur de file d'attente, activez les journaux verbose et surveillez les lignes de timing de file d'attente.
