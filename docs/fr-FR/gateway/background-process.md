---
summary: "Exécution exec en arrière-plan et gestion de processus"
read_when:
  - Ajout ou modification du comportement exec en arrière-plan
  - Débogage de tâches exec de longue durée
title: "Exec en arrière-plan et outil Process"
---

# Exec en arrière-plan + Outil Process

OpenClaw exécute les commandes shell via l'outil `exec` et conserve les tâches de longue durée en mémoire. L'outil `process` gère ces sessions en arrière-plan.

## Outil exec

Paramètres clés :

- `command` (requis)
- `yieldMs` (défaut 10000) : mise en arrière-plan automatique après ce délai
- `background` (bool) : mise en arrière-plan immédiate
- `timeout` (secondes, défaut 1800) : tue le processus après ce timeout
- `elevated` (bool) : exécute sur l'hôte si le mode élevé est activé/autorisé
- Besoin d'un vrai TTY ? Définissez `pty: true`.
- `workdir`, `env`

Comportement :

- Les exécutions de premier plan retournent la sortie directement.
- Lorsque mis en arrière-plan (explicite ou timeout), l'outil retourne `status: "running"` + `sessionId` et une courte fin.
- La sortie est conservée en mémoire jusqu'à ce que la session soit interrogée ou effacée.
- Si l'outil `process` n'est pas autorisé, `exec` s'exécute de manière synchrone et ignore `yieldMs`/`background`.

## Pont de processus enfant

Lors du lancement de processus enfants de longue durée en dehors des outils exec/process (par exemple, respawns CLI ou helpers passerelle), attachez l'helper de pont de processus enfant afin que les signaux de terminaison soient transférés et les écouteurs détachés lors de la sortie/erreur. Cela évite les processus orphelins sur systemd et maintient un comportement d'arrêt cohérent sur toutes les plateformes.

Overrides d'environnement :

- `PI_BASH_YIELD_MS` : yield par défaut (ms)
- `PI_BASH_MAX_OUTPUT_CHARS` : plafond de sortie en mémoire (caractères)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` : plafond stdout/stderr en attente par flux (caractères)
- `PI_BASH_JOB_TTL_MS` : TTL pour les sessions terminées (ms, borné à 1m–3h)

Config (préféré) :

- `tools.exec.backgroundMs` (défaut 10000)
- `tools.exec.timeoutSec` (défaut 1800)
- `tools.exec.cleanupMs` (défaut 1800000)
- `tools.exec.notifyOnExit` (défaut true) : met en file d'attente un événement système + demande heartbeat quand un exec en arrière-plan se termine.
- `tools.exec.notifyOnExitEmptySuccess` (défaut false) : quand true, met également en file d'attente des événements de complétion pour les exécutions en arrière-plan réussies qui n'ont produit aucune sortie.

## Outil process

Actions :

- `list` : sessions en cours + terminées
- `poll` : vider la nouvelle sortie pour une session (rapporte aussi le statut de sortie)
- `log` : lire la sortie agrégée (supporte `offset` + `limit`)
- `write` : envoyer stdin (`data`, `eof` optionnel)
- `kill` : terminer une session en arrière-plan
- `clear` : supprimer une session terminée de la mémoire
- `remove` : tuer si en cours, sinon effacer si terminée

Notes :

- Seules les sessions mises en arrière-plan sont listées/persistées en mémoire.
- Les sessions sont perdues au redémarrage du processus (pas de persistance disque).
- Les journaux de session ne sont sauvegardés dans l'historique de chat que si vous exécutez `process poll/log` et que le résultat de l'outil est enregistré.
- `process` est scopé par agent ; il ne voit que les sessions démarrées par cet agent.
- `process list` inclut un `name` dérivé (verbe de commande + cible) pour les scans rapides.
- `process log` utilise `offset`/`limit` basés sur les lignes.
- Lorsque `offset` et `limit` sont tous deux omis, il retourne les dernières 200 lignes et inclut un indice de pagination.
- Lorsque `offset` est fourni et `limit` est omis, il retourne de `offset` à la fin (pas plafonné à 200).

## Exemples

Exécuter une longue tâche et interroger plus tard :

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Démarrer immédiatement en arrière-plan :

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Envoyer stdin :

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
