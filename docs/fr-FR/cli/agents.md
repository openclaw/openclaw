---
summary: "Référence CLI pour `openclaw agents` (lister/ajouter/supprimer/définir identité)"
read_when:
  - Vous voulez plusieurs agents isolés (espaces de travail + routage + auth)
title: "agents"
---

# `openclaw agents`

Gérer les agents isolés (espaces de travail + auth + routage).

Connexe :

- Routage multi-agent : [Routage Multi-Agent](/fr-FR/concepts/multi-agent)
- Espace de travail d'agent : [Espace de travail d'agent](/fr-FR/concepts/agent-workspace)

## Exemples

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Fichiers d'identité

Chaque espace de travail d'agent peut inclure un `IDENTITY.md` à la racine de l'espace de travail :

- Exemple de chemin : `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` lit depuis la racine de l'espace de travail (ou un `--identity-file` explicite)

Les chemins d'avatar se résolvent relatifs à la racine de l'espace de travail.

## Définir l'identité

`set-identity` écrit des champs dans `agents.list[].identity` :

- `name`
- `theme`
- `emoji`
- `avatar` (chemin relatif à l'espace de travail, URL http(s), ou URI data)

Charger depuis `IDENTITY.md` :

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Remplacer les champs explicitement :

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Exemple de config :

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
