---
summary: "Référence CLI pour `openclaw system` (événements système, heartbeat, présence)"
read_when:
  - Vous voulez mettre en file d'attente un événement système sans créer une tâche cron
  - Vous devez activer ou désactiver les heartbeats
  - Vous voulez inspecter les entrées de présence système
title: "system"
---

# `openclaw system`

Aides au niveau système pour la Passerelle : mettre en file d'attente des événements système, contrôler les heartbeats, et voir la présence.

## Commandes courantes

```bash
openclaw system event --text "Vérifier les suivis urgents" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Mettre en file d'attente un événement système sur la session **main**. Le prochain heartbeat l'injectera comme une ligne `System:` dans le prompt. Utilisez `--mode now` pour déclencher le heartbeat immédiatement ; `next-heartbeat` attend le prochain tic planifié.

Flags :

- `--text <text>` : texte d'événement système requis.
- `--mode <mode>` : `now` ou `next-heartbeat` (par défaut).
- `--json` : sortie lisible par machine.

## `system heartbeat last|enable|disable`

Contrôles heartbeat :

- `last` : afficher le dernier événement heartbeat.
- `enable` : réactiver les heartbeats (utilisez ceci s'ils étaient désactivés).
- `disable` : mettre en pause les heartbeats.

Flags :

- `--json` : sortie lisible par machine.

## `system presence`

Lister les entrées de présence système actuelles que la Passerelle connaît (nœuds, instances, et lignes de statut similaires).

Flags :

- `--json` : sortie lisible par machine.

## Notes

- Nécessite une Passerelle en cours d'exécution accessible par votre config actuelle (locale ou distante).
- Les événements système sont éphémères et ne persistent pas entre les redémarrages.
