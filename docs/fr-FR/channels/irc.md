---
title: IRC
description: Connectez OpenClaw aux canaux IRC et messages directs.
---

Utilisez IRC quand vous voulez OpenClaw dans les canaux classiques (`#room`) et les messages directs.
IRC est fourni comme plugin d'extension, mais il est configuré dans la config principale sous `channels.irc`.

## Démarrage rapide

1. Activez la config IRC dans `~/.openclaw/openclaw.json`.
2. Définissez au moins :

```json
{
  "channels": {
    "irc": {
      "enabled": true,
      "host": "irc.libera.chat",
      "port": 6697,
      "tls": true,
      "nick": "openclaw-bot",
      "channels": ["#openclaw"]
    }
  }
}
```

3. Démarrez/redémarrez la passerelle :

```bash
openclaw gateway run
```

## Paramètres de sécurité par défaut

- `channels.irc.dmPolicy` vaut par défaut `"pairing"`.
- `channels.irc.groupPolicy` vaut par défaut `"allowlist"`.
- Avec `groupPolicy="allowlist"`, définissez `channels.irc.groups` pour spécifier les canaux autorisés.
- Utilisez TLS (`channels.irc.tls=true`) sauf si vous acceptez intentionnellement le transport en texte clair.

## Contrôle d'accès

Il existe deux "portes" séparées pour les canaux IRC :

1. **Accès au canal** (`groupPolicy` + `groups`) : si le bot accepte les messages d'un canal du tout.
2. **Accès expéditeur** (`groupAllowFrom` / par canal `groups["#channel"].allowFrom`) : qui est autorisé à déclencher le bot dans ce canal.

Clés de configuration :

- Liste blanche DM (accès expéditeur DM) : `channels.irc.allowFrom`
- Liste blanche expéditeur de groupe (accès expéditeur de canal) : `channels.irc.groupAllowFrom`
- Contrôles par canal (canal + expéditeur + règles de mention) : `channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` permet les canaux non configurés (**toujours bloqués par mention par défaut**)

Les entrées de liste blanche peuvent utiliser les formes nick ou `nick!user@host`.

### Piège courant : `allowFrom` est pour les DM, pas les canaux

Si vous voyez des logs comme :

- `irc: drop group sender alice!ident@host (policy=allowlist)`

…cela signifie que l'expéditeur n'était pas autorisé pour les messages **groupe/canal**. Corrigez en soit :

- définissant `channels.irc.groupAllowFrom` (global pour tous les canaux), ou
- définissant des listes blanches d'expéditeur par canal : `channels.irc.groups["#channel"].allowFrom`

Exemple (autoriser tout le monde dans `#tuirc-dev` à parler au bot) :

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": { allowFrom: ["*"] },
      },
    },
  },
}
```

## Déclenchement de réponse (mentions)

Même si un canal est autorisé (via `groupPolicy` + `groups`) et l'expéditeur est autorisé, OpenClaw utilise par défaut **le blocage par mention** dans les contextes de groupe.

Cela signifie que vous pouvez voir des logs comme `drop channel … (missing-mention)` sauf si le message inclut un motif de mention qui correspond au bot.

Pour faire répondre le bot dans un canal IRC **sans nécessiter de mention**, désactivez le blocage par mention pour ce canal :

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": {
          requireMention: false,
          allowFrom: ["*"],
        },
      },
    },
  },
}
```

Ou pour autoriser **tous** les canaux IRC (pas de liste blanche par canal) et quand même répondre sans mentions :

```json5
{
  channels: {
    irc: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false, allowFrom: ["*"] },
      },
    },
  },
}
```

## Note de sécurité (recommandé pour les canaux publics)

Si vous autorisez `allowFrom: ["*"]` dans un canal public, n'importe qui peut inviter le bot.
Pour réduire le risque, restreignez les outils pour ce canal.

### Mêmes outils pour tout le monde dans le canal

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          tools: {
            deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
          },
        },
      },
    },
  },
}
```

### Outils différents par expéditeur (le propriétaire obtient plus de pouvoir)

Utilisez `toolsBySender` pour appliquer une politique plus stricte à `"*"` et une plus souple à votre nick :

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          toolsBySender: {
            "*": {
              deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
            },
            eigen: {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

Notes :

- Les clés `toolsBySender` peuvent être un nick (ex. `"eigen"`) ou un hostmask complet (`"eigen!~eigen@174.127.248.171"`) pour une correspondance d'identité plus forte.
- La première politique d'expéditeur correspondante gagne ; `"*"` est la solution de secours générique.

Pour plus d'informations sur l'accès au groupe vs blocage par mention (et comment ils interagissent), voir : [/fr-FR/channels/groups](/fr-FR/channels/groups).

## NickServ

Pour s'identifier avec NickServ après connexion :

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "enabled": true,
        "service": "NickServ",
        "password": "votre-mot-de-passe-nickserv"
      }
    }
  }
}
```

Enregistrement unique optionnel à la connexion :

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "register": true,
        "registerEmail": "bot@example.com"
      }
    }
  }
}
```

Désactivez `register` après l'enregistrement du nick pour éviter les tentatives REGISTER répétées.

## Variables d'environnement

Le compte par défaut supporte :

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS` (séparés par des virgules)
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

## Dépannage

- Si le bot se connecte mais ne répond jamais dans les canaux, vérifiez `channels.irc.groups` **et** si le blocage par mention abandonne les messages (`missing-mention`). Si vous voulez qu'il réponde sans pings, définissez `requireMention:false` pour le canal.
- Si la connexion échoue, vérifiez la disponibilité du nick et le mot de passe du serveur.
- Si TLS échoue sur un réseau personnalisé, vérifiez la configuration host/port et certificat.
