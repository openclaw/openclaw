---
summary: "Reference CLI pour `openclaw system` (evenements systeme, heartbeat, presence)"
read_when:
  - Vous souhaitez mettre en file d'attente un evenement systeme sans creer une tache cron
  - Vous devez activer ou desactiver les heartbeats
  - Vous souhaitez inspecter les entrees de presence systeme
title: "system"
---

# `openclaw system`

Aides au niveau systeme pour la Gateway (passerelle) : mettre en file d'attente des evenements systeme, controler les heartbeats,
et consulter la presence.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Met en file d'attente un evenement systeme sur la session **main**. Le prochain heartbeat l'injectera
comme une ligne `System:` dans le prompt. Utilisez `--mode now` pour declencher le heartbeat
immediatement ; `next-heartbeat` attend le prochain tick planifie.

Drapeaux :

- `--text <text>` : texte d'evenement systeme requis.
- `--mode <mode>` : `now` ou `next-heartbeat` (par defaut).
- `--json` : sortie lisible par machine.

## `system heartbeat last|enable|disable`

Controles des heartbeats :

- `last` : afficher le dernier evenement de heartbeat.
- `enable` : reactiver les heartbeats (utilisez ceci s'ils etaient desactives).
- `disable` : mettre en pause les heartbeats.

Drapeaux :

- `--json` : sortie lisible par machine.

## `system presence`

Liste les entrees de presence systeme actuelles connues par la Gateway (passerelle) (noeuds,
instances et lignes de statut similaires).

Drapeaux :

- `--json` : sortie lisible par machine.

## Notes

- Necessite une Gateway (passerelle) en cours d'execution, accessible via votre configuration actuelle (locale ou distante).
- Les evenements systeme sont ephemeres et ne sont pas persistants entre les redemarrages.
