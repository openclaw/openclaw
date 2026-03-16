---
summary: "Référence CLI pour `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Vous gérez des nœuds appairés (caméras, écran, canvas)
  - Vous devez approuver des demandes ou invoquer des commandes de nœud
title: "nodes"
---

# `openclaw nodes`

Gérer les nœuds appairés (appareils) et invoquer les capacités de nœud.

Connexe :

- Aperçu des nœuds : [Nœuds](/fr-FR/nodes)
- Caméra : [Nœuds caméra](/fr-FR/nodes/camera)
- Images : [Nœuds d'images](/fr-FR/nodes/images)

Options courantes :

- `--url`, `--token`, `--timeout`, `--json`

## Commandes courantes

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

`nodes list` affiche des tables pending/paired. Les lignes appairées incluent l'âge de connexion le plus récent (Last Connect).
Utilisez `--connected` pour afficher uniquement les nœuds actuellement connectés. Utilisez `--last-connected <duration>` pour filtrer les nœuds qui se sont connectés dans une durée (ex. `24h`, `7d`).

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Flags invoke :

- `--params <json>` : chaîne d'objet JSON (par défaut `{}`).
- `--invoke-timeout <ms>` : timeout d'invocation de nœud (par défaut `15000`).
- `--idempotency-key <key>` : clé d'idempotence optionnelle.

### Défauts de style exec

`nodes run` reflète le comportement exec du modèle (défauts + approbations) :

- Lit `tools.exec.*` (plus les remplacements `agents.list[].tools.exec.*`).
- Utilise les approbations exec (`exec.approval.request`) avant d'invoquer `system.run`.
- `--node` peut être omis quand `tools.exec.node` est défini.
- Nécessite un nœud qui annonce `system.run` (app compagnon macOS ou hôte de nœud sans tête).

Flags :

- `--cwd <path>` : répertoire de travail.
- `--env <key=val>` : remplacement env (répétable). Note : les hôtes de nœud ignorent les remplacements `PATH` (et `tools.exec.pathPrepend` n'est pas appliqué aux hôtes de nœud).
- `--command-timeout <ms>` : timeout de commande.
- `--invoke-timeout <ms>` : timeout d'invocation de nœud (par défaut `30000`).
- `--needs-screen-recording` : nécessite la permission d'enregistrement d'écran.
- `--raw <command>` : exécuter une chaîne shell (`/bin/sh -lc` ou `cmd.exe /c`).
- `--agent <id>` : approbations/listes blanches à portée d'agent (par défaut l'agent configuré).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>` : remplacements.
