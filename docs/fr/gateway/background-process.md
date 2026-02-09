---
summary: "Exécution en arrière-plan et gestion des processus"
read_when:
  - Ajout ou modification du comportement d’exécution en arrière-plan
  - Débogage de tâches d’exécution de longue durée
title: "Outil d’exécution en arrière-plan et de processus"
---

# Outil d’exécution en arrière-plan + processus

OpenClaw exécute des commandes shell via l’outil `exec` et conserve les tâches de longue durée en mémoire. L’outil `process` gère ces sessions en arrière-plan.

## outil exec

Paramètres clés :

- `command` (requis)
- `yieldMs` (par défaut 10000) : passage automatique en arrière-plan après ce délai
- `background` (bool) : exécuter immédiatement en arrière-plan
- `timeout` (secondes, par défaut 1800) : arrêter le processus après ce délai
- `elevated` (bool) : exécuter sur l’hôte si le mode élevé est activé/autorisé
- Besoin d’un vrai TTY ? Définissez `pty: true`.
- `workdir`, `env`

Comportement :

- Les exécutions au premier plan renvoient directement la sortie.
- Lorsqu’il est mis en arrière-plan (explicitement ou par dépassement de délai), l’outil renvoie `status: "running"` + `sessionId` et une courte fin de sortie.
- La sortie est conservée en mémoire jusqu’à ce que la session soit interrogée ou effacée.
- Si l’outil `process` est interdit, `exec` s’exécute de manière synchrone et ignore `yieldMs`/`background`.

## Pontage des processus enfants

Lors du lancement de processus enfants de longue durée en dehors des outils exec/process (par exemple, des relances de CLI ou des assistants de Gateway (passerelle)), attachez l’assistant de pontage des processus enfants afin que les signaux de terminaison soient relayés et que les écouteurs soient détachés lors de la sortie ou d’une erreur. Cela évite les processus orphelins sous systemd et maintient un comportement d’arrêt cohérent entre les plateformes.

Substitutions d'environnement :

- `PI_BASH_YIELD_MS` : rendement par défaut (ms)
- `PI_BASH_MAX_OUTPUT_CHARS` : limite de sortie en mémoire (caractères)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` : limite de stdout/stderr en attente par flux (caractères)
- `PI_BASH_JOB_TTL_MS` : TTL des sessions terminées (ms, borné entre 1 min et 3 h)

Configuration (préférée) :

- `tools.exec.backgroundMs` (par défaut 10000)
- `tools.exec.timeoutSec` (par défaut 1800)
- `tools.exec.cleanupMs` (par défaut 1800000)
- `tools.exec.notifyOnExit` (par défaut true) : mettre en file un événement système + demander un heartbeat lorsque l’exécution en arrière-plan se termine.

## outil process

Actions :

- `list` : sessions en cours + terminées
- `poll` : récupérer la nouvelle sortie d’une session (rapporte aussi le statut de sortie)
- `log` : lire la sortie agrégée (prend en charge `offset` + `limit`)
- `write` : envoyer stdin (`data`, `eof` optionnel)
- `kill` : terminer une session en arrière-plan
- `clear` : supprimer une session terminée de la mémoire
- `remove` : tuer si en cours d’exécution, sinon effacer si terminée

Notes :

- Seules les sessions en arrière-plan sont listées/conservées en mémoire.
- Les sessions sont perdues lors du redémarrage du processus (pas de persistance sur disque).
- Les journaux de session ne sont enregistrés dans l’historique de chat que si vous exécutez `process poll/log` et que le résultat de l’outil est enregistré.
- `process` est limité à l’agent ; il ne voit que les sessions démarrées par cet agent.
- `process list` inclut un `name` dérivé (verbe de commande + cible) pour des analyses rapides.
- `process log` utilise des `offset`/`limit` basés sur les lignes (omettre `offset` pour récupérer les N dernières lignes).

## Exemples

Exécuter une tâche longue et interroger plus tard :

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Démarrer immédiatement en arrière-plan :

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Envoyer stdin :

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
