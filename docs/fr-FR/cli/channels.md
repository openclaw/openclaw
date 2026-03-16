---
summary: "Référence CLI pour `openclaw channels` (comptes, statut, login/logout, logs)"
read_when:
  - Vous voulez ajouter/retirer des comptes de canal (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Vous voulez vérifier le statut de canal ou suivre les logs de canal
title: "channels"
---

# `openclaw channels`

Gérer les comptes de canal de discussion et leur statut d'exécution sur la Passerelle.

Docs connexes :

- Guides de canaux : [Canaux](/fr-FR/channels/index)
- Configuration de Passerelle : [Configuration](/fr-FR/gateway/configuration)

## Commandes courantes

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Ajouter / retirer des comptes

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Astuce : `openclaw channels add --help` affiche les drapeaux par canal (token, app token, chemins signal-cli, etc).

## Login / logout (interactif)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Dépannage

- Exécutez `openclaw status --deep` pour une sonde large.
- Utilisez `openclaw doctor` pour des corrections guidées.
- `openclaw channels list` affiche `Claude: HTTP 403 ... user:profile` → l'instantané d'utilisation nécessite la portée `user:profile`. Utilisez `--no-usage`, ou fournissez une clé de session claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), ou réauthentifiez via Claude Code CLI.

## Sonde de capacités

Récupérer les indices de capacité du fournisseur (intents/portées quand disponibles) plus support de fonctionnalité statique :

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notes :

- `--channel` est optionnel ; omettez-le pour lister tous les canaux (y compris les extensions).
- `--target` accepte `channel:<id>` ou un id de canal numérique brut et s'applique uniquement à Discord.
- Les sondes sont spécifiques au fournisseur : intents Discord + permissions de canal optionnelles ; portées bot + utilisateur Slack ; drapeaux bot Telegram + webhook ; version daemon Signal ; token d'app MS Teams + rôles/portées Graph (annotés quand connus). Les canaux sans sondes rapportent `Probe: unavailable`.

## Résoudre les noms en ID

Résoudre les noms de canal/utilisateur en ID en utilisant le répertoire du fournisseur :

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notes :

- Utilisez `--kind user|group|auto` pour forcer le type de cible.
- La résolution préfère les correspondances actives quand plusieurs entrées partagent le même nom.
