---
summary: "Référence CLI pour `openclaw approvals` (approbations exec pour passerelle ou hôtes de nœuds)"
read_when:
  - Vous voulez modifier les approbations exec depuis la CLI
  - Vous devez gérer les listes blanches sur la passerelle ou les hôtes de nœuds
title: "approvals"
---

# `openclaw approvals`

Gérer les approbations exec pour **l'hôte local**, **l'hôte passerelle**, ou un **hôte nœud**.
Par défaut, les commandes ciblent le fichier d'approbations local sur disque. Utilisez `--gateway` pour cibler la passerelle, ou `--node` pour cibler un nœud spécifique.

Connexe :

- Approbations exec : [Approbations exec](/fr-FR/tools/exec-approvals)
- Nœuds : [Nœuds](/fr-FR/nodes)

## Commandes courantes

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Remplacer les approbations depuis un fichier

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Aides de liste blanche

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--node` utilise le même résolveur que `openclaw nodes` (id, name, ip, ou préfixe id).
- `--agent` vaut par défaut `"*"`, qui s'applique à tous les agents.
- L'hôte nœud doit annoncer `system.execApprovals.get/set` (app macOS ou hôte nœud sans tête).
- Les fichiers d'approbations sont stockés par hôte à `~/.openclaw/exec-approvals.json`.
