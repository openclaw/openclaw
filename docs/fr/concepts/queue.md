---
summary: "Conception d’une file de commandes qui sérialise les exécutions d’auto-réponse entrantes"
read_when:
  - Modification de l’exécution ou de la concurrence des auto-réponses
title: "File de commandes"
---

# File de commandes (2026-01-16)

Nous sérialisons les exécutions d’auto-réponse entrantes (tous les canaux) via une minuscule file en mémoire du processus afin d’éviter les collisions entre plusieurs exécutions d’agents, tout en permettant un parallélisme sûr entre les sessions.

## Pourquoi

- Les exécutions d’auto-réponse peuvent être coûteuses (appels LLM) et entrer en collision lorsque plusieurs messages entrants arrivent à peu d’intervalle.
- La sérialisation évite la concurrence pour des ressources partagées (fichiers de session, journaux, stdin du CLI) et réduit le risque de limites de débit en amont.

## Fonctionnement

- Une file FIFO consciente des lanes draine chaque lane avec un plafond de concurrence configurable (par défaut 1 pour les lanes non configurées ; la lane principale est à 4 par défaut, la lane subagent à 8).
- `runEmbeddedPiAgent` met en file par **clé de session** (lane `session:<key>`) afin de garantir une seule exécution active par session.
- Chaque exécution de session est ensuite mise en file dans une **lane globale** (`main` par défaut) afin que le parallélisme global soit plafonné par `agents.defaults.maxConcurrent`.
- Lorsque la journalisation verbeuse est activée, les exécutions en file émettent un bref avis si elles ont attendu plus d’environ ~2 s avant de démarrer.
- Les indicateurs de saisie se déclenchent toujours immédiatement lors de la mise en file (lorsque le canal le prend en charge), de sorte que l’expérience utilisateur reste inchangée pendant l’attente.

## Modes de file (par canal)

Les messages entrants peuvent orienter l’exécution en cours, attendre un tour de suivi, ou faire les deux :

- `steer` : injecte immédiatement dans l’exécution en cours (annule les appels d’outil en attente après la prochaine frontière d’outil). En l’absence de streaming, revient au suivi.
- `followup` : met en file pour le prochain tour de l’agent après la fin de l’exécution en cours.
- `collect` : fusionne tous les messages en file en **un seul** tour de suivi (par défaut). Si les messages ciblent des canaux/fils différents, ils sont drainés individuellement pour préserver le routage.
- `steer-backlog` (alias `steer+backlog`) : oriente maintenant **et** conserve le message pour un tour de suivi.
- `interrupt` (hérité) : abandonne l’exécution active pour cette session, puis exécute le message le plus récent.
- `queue` (alias hérité) : identique à `steer`.

Steer-backlog signifie que vous pouvez obtenir une réponse de suivi après l’exécution orientée ; ainsi,
les surfaces en streaming peuvent sembler produire des doublons. Préférez `collect`/`steer` si vous souhaitez
une réponse par message entrant.
Envoyez `/queue collect` comme commande autonome (par session) ou définissez `messages.queue.byChannel.discord: "collect"`.

Valeurs par défaut (lorsqu’elles ne sont pas définies dans la configuration) :

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

## Options de la file d'attente

Les options s’appliquent à `followup`, `collect` et `steer-backlog` (ainsi qu’à `steer` lorsqu’il revient au suivi) :

- `debounceMs` : attendre une période de calme avant de démarrer un tour de suivi (empêche « continuer, continuer »).
- `cap` : nombre maximal de messages en file par session.
- `drop` : politique de dépassement (`old`, `new`, `summarize`).

Le mode « summarize » conserve une courte liste à puces des messages supprimés et l’injecte comme une invite de suivi synthétique.
Valeurs par défaut : `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Remplacements par session

- Envoyez `/queue <mode>` comme commande autonome pour enregistrer le mode pour la session en cours.
- Les options peuvent être combinées : `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` ou `/queue reset` efface le remplacement de session.

## Portée et garanties

- S’applique aux exécutions d’agents en auto-réponse sur tous les canaux entrants qui utilisent le pipeline de réponse de la Gateway (passerelle) (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- La lane par défaut (`main`) est à l’échelle du processus pour les entrants + battements de cœur principaux ; définissez `agents.defaults.maxConcurrent` pour autoriser plusieurs sessions en parallèle.
- Des lanes supplémentaires peuvent exister (par ex. `cron`, `subagent`) afin que les tâches en arrière-plan puissent s’exécuter en parallèle sans bloquer les réponses entrantes.
- Les lanes par session garantissent qu’une seule exécution d’agent touche une session donnée à la fois.
- Aucune dépendance externe ni threads de workers en arrière-plan ; TypeScript pur + promesses.

## Problemes courants

- Si des commandes semblent bloquées, activez les journaux verbeux et recherchez les lignes « queued for …ms » pour confirmer que la file se vide.
- Si vous avez besoin de la profondeur de file, activez les journaux verbeux et surveillez les lignes de temporisation de la file.
