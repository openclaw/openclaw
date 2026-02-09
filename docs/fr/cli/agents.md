---
summary: "Reference CLI pour `openclaw agents` (lister/ajouter/supprimer/definir l'identite)"
read_when:
  - Vous souhaitez plusieurs agents isoles (espaces de travail + routage + authentification)
title: "agents"
---

# `openclaw agents`

Gerez des agents isoles (espaces de travail + authentification + routage).

Liens connexes :

- Routage multi-agents : [Multi-Agent Routing](/concepts/multi-agent)
- Espace de travail d'agent : [Agent workspace](/concepts/agent-workspace)

## Exemples

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Fichiers d'identite

Chaque espace de travail d'agent peut inclure un `IDENTITY.md` a la racine de l'espace de travail :

- Exemple de chemin : `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` lit depuis la racine de l'espace de travail (ou un `--identity-file` explicite)

Les chemins d'avatar sont resolus relativement a la racine de l'espace de travail.

## Definir l'identite

`set-identity` ecrit des champs dans `agents.list[].identity` :

- `name`
- `theme`
- `emoji`
- `avatar` (chemin relatif a l'espace de travail, URL http(s) ou URI de donnees)

Charger depuis `IDENTITY.md` :

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Remplacer les champs explicitement :

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Exemple de configuration :

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
