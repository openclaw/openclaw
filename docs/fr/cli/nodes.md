---
summary: "Reference CLI pour `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Vous gerez des nœuds appaires (cameras, ecran, canevas)
  - Vous devez approuver des requetes ou invoquer des commandes de nœud
title: "nœuds"
---

# `openclaw nodes`

Gérer les nœuds appariés (périphériques) et appeler les capacités des nœuds.

Liens connexes :

- Vue d’ensemble des nœuds : [Nodes](/nodes)
- Camera : [Camera nodes](/nodes/camera)
- Images : [Image nodes](/nodes/images)

Options communes :

- `--url`, `--token`, `--timeout`, `--json`

## Commandes communes

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` affiche des tableaux des nœuds en attente/appaires. Les lignes appairees incluent l’age de la connexion la plus recente (Last Connect).
Utilisez `--connected` pour afficher uniquement les nœuds actuellement connectes. Utilisez `--last-connected <duration>` pour
filtrer les nœuds qui se sont connectes dans une duree donnee (par ex. `24h`, `7d`).

## Invoquer / executer

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoquer les drapeaux :

- `--params <json>` : chaine d’objet JSON (par defaut `{}`).
- `--invoke-timeout <ms>` : delai d’expiration d’invocation du nœud (par defaut `15000`).
- `--idempotency-key <key>` : cle d’idempotence optionnelle.

### Par défaut de style Exécutif

`nodes run` reflète le comportement exec du modele (valeurs par defaut + approbations) :

- Lit `tools.exec.*` (avec des remplacements `agents.list[].tools.exec.*`).
- Utilise les approbations exec (`exec.approval.request`) avant d’invoquer `system.run`.
- `--node` peut etre omis lorsque `tools.exec.node` est defini.
- Necessite un nœud qui annonce `system.run` (application compagnon macOS ou hote de nœud headless).

Drapeaux :

- `--cwd <path>` : repertoire de travail.
- `--env <key=val>` : remplacement d’env (repetable).
- `--command-timeout <ms>` : delai d’expiration de la commande.
- `--invoke-timeout <ms>` : delai d’expiration d’invocation du nœud (par defaut `30000`).
- `--needs-screen-recording` : exiger l’autorisation d’enregistrement d’ecran.
- `--raw <command>` : executer une chaine shell (`/bin/sh -lc` ou `cmd.exe /c`).
- `--agent <id>` : approbations/listes d’autorisations portees a l’agent (par defaut l’agent configure).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>` : remplacements.
