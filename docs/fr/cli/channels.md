---
summary: "Reference CLI pour `openclaw channels` (comptes, statut, connexion/deconnexion, journaux)"
read_when:
  - Vous souhaitez ajouter/supprimer des comptes de canal (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Vous souhaitez verifier le statut d'un canal ou suivre les journaux d'un canal
title: "canaux"
---

# `openclaw channels`

Gerez les comptes des canaux de chat et leur statut d'execution sur le Gateway (passerelle).

Documentation associee :

- Guides des canaux : [Channels](/channels/index)
- Configuration du Gateway : [Configuration](/gateway/configuration)

## Commandes courantes

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Ajouter / supprimer des comptes

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Astuce : `openclaw channels add --help` affiche les options par canal (jeton, jeton d'application, chemins signal-cli, etc.).

## Connexion / deconnexion (interactive)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Problemes courants

- Executez `openclaw status --deep` pour un diagnostic general.
- Utilisez `openclaw doctor` pour des corrections guidees.
- `openclaw channels list` affiche `Claude: HTTP 403 ... user:profile` → l'instantane d'utilisation necessite la portee `user:profile`. Utilisez `--no-usage`, ou fournissez une cle de session claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), ou re-authentifiez-vous via la CLI Claude Code.

## Sondage des capacites

Récupérer les astuces de capacité du fournisseur (intentions/portées si disponible) ainsi que la prise en charge des fonctionnalités statiques :

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notes :

- `--channel` est optionnel ; omettez-le pour lister tous les canaux (y compris les extensions).
- `--target` accepte `channel:<id>` ou un identifiant de canal numerique brut et s'applique uniquement a Discord.
- Les sondages sont specifiques au fournisseur : intentions Discord + autorisations de canal facultatives ; portees du bot + de l'utilisateur Slack ; indicateurs du bot Telegram + webhook ; version du demon Signal ; jeton d'application MS Teams + roles/portees Graph (annotes lorsque connus). Les canaux sans sondage signalent `Probe: unavailable`.

## Resoudre les noms en identifiants

Resoudre les noms de canal/utilisateur en identifiants a l'aide de l'annuaire du fournisseur :

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notes :

- Utilisez `--kind user|group|auto` pour forcer le type de cible.
- La resolution privilegie les correspondances actives lorsque plusieurs entrees partagent le meme nom.
