---
summary: "Comportement des discussions de groupe sur les différentes surfaces (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Modification du comportement des discussions de groupe ou du filtrage par mention
title: "Groupes"
---

# Groupes

OpenClaw traite les discussions de groupe de manière cohérente sur les différentes surfaces : WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Introduction pour débutants (2 minutes)

OpenClaw « vit » sur vos propres comptes de messagerie. Il n’y a pas d’utilisateur bot WhatsApp distinct.
Si **vous** êtes dans un groupe, OpenClaw peut voir ce groupe et y répondre.

Comportement par défaut :

- Les groupes sont restreints (`groupPolicy: "allowlist"`).
- Les réponses nécessitent une mention, sauf si vous désactivez explicitement le filtrage par mention.

Traduction : les expéditeurs figurant sur la liste d’autorisation peuvent déclencher OpenClaw en le mentionnant.

> TL;DR
>
> - L’**accès en messages privés** est contrôlé par `*.allowFrom`.
> - L’**accès aux groupes** est contrôlé par `*.groupPolicy` + les listes d’autorisation (`*.groups`, `*.groupAllowFrom`).
> - Le **déclenchement des réponses** est contrôlé par le filtrage par mention (`requireMention`, `/activation`).

Flux rapide (ce qui arrive à un message de groupe) :

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Flux des messages de groupe](/images/groups-flow.svg)

Si vous voulez…

| Objectif                                                                       | Ce qu'il faut définir                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Autoriser tous les groupes mais répondre uniquement aux @mentions | `groups: { "*": { requireMention: true } }`                             |
| Désactiver toutes les réponses de groupe                                       | `groupPolicy: "disabled"`                                               |
| Uniquement des groupes spécifiques                                             | `groups: { "<group-id>": { ... } }` (sans clé `"*"`) |
| Vous seul pouvez déclencher dans les groupes                                   | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`              |

## Clés de session

- Les sessions de groupe utilisent des clés de session `agent:<agentId>:<channel>:group:<id>` (les salles/canaux utilisent `agent:<agentId>:<channel>:channel:<id>`).
- Les sujets de forum Telegram ajoutent `:topic:<threadId>` à l’identifiant de groupe afin que chaque sujet ait sa propre session.
- Les discussions directes utilisent la session principale (ou par expéditeur si configuré).
- Les battements de cœur sont ignorés pour les sessions de groupe.

## Modèle : messages privés personnels + groupes publics (agent unique)

Oui — cela fonctionne très bien si votre trafic « personnel » correspond aux **messages privés** et votre trafic « public » aux **groupes**.

Pourquoi : en mode agent unique, les messages privés arrivent généralement dans la clé de session **principale** (`agent:main:main`), tandis que les groupes utilisent toujours des clés de session **non principales** (`agent:main:<channel>:group:<id>`). Si vous activez le sandboxing avec `mode: "non-main"`, ces sessions de groupe s’exécutent dans Docker tandis que votre session principale de messages privés reste sur l’hôte.

Cela vous donne un seul « cerveau » d’agent (espace de travail + mémoire partagés), mais deux postures d’exécution :

- **Messages privés** : outils complets (hôte)
- **Groupes** : sandbox + outils restreints (Docker)

> Si vous avez besoin d’espaces de travail/personas réellement séparés (« personnel » et « public » ne doivent jamais se mélanger), utilisez un second agent + des liaisons. Voir [Routage multi-agents](/concepts/multi-agent).

Exemple (messages privés sur l’hôte, groupes dans un sandbox + outils de messagerie uniquement) :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Vous voulez que « les groupes ne voient que le dossier X » au lieu de « aucun accès à l’hôte » ? Conservez `workspaceAccess: "none"` et montez uniquement les chemins figurant sur la liste d’autorisation dans le sandbox :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Liens associés :

- Clés de configuration et valeurs par défaut : [Configuration de la Gateway (passerelle)](/gateway/configuration#agentsdefaultssandbox)
- Déboguer pourquoi un outil est bloqué : [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Détails des montages bind : [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Libellés d’affichage

- Les libellés de l’UI utilisent `displayName` lorsque disponible, formatés comme `<channel>:<token>`.
- `#room` est réservé aux salles/canaux ; les discussions de groupe utilisent `g-<slug>` (minuscules, espaces -> `-`, conserver `#@+._-`).

## Politique de groupe

Contrôlez la manière dont les messages de groupe/salle sont traités par canal :

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Politique     | Comportement                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `"open"`      | Les groupes contournent les listes d’autorisation ; le filtrage par mention s’applique toujours. |
| `"disabled"`  | Bloquer entièrement tous les messages de groupe.                                                 |
| `"allowlist"` | Autoriser uniquement les groupes/salles correspondant à la liste d’autorisation configurée.      |

Remarques :

- `groupPolicy` est distinct du filtrage par mention (qui nécessite des @mentions).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams : utiliser `groupAllowFrom` (repli : `allowFrom` explicite).
- Discord : la liste d’autorisation utilise `channels.discord.guilds.<id>.channels`.
- Slack : la liste d’autorisation utilise `channels.slack.channels`.
- Matrix : la liste d’autorisation utilise `channels.matrix.groups` (identifiants de salle, alias ou noms). Utilisez `channels.matrix.groupAllowFrom` pour restreindre les expéditeurs ; des listes d’autorisation `users` par salle sont également prises en charge.
- Les messages privés de groupe sont contrôlés séparément (`channels.discord.dm.*`, `channels.slack.dm.*`).
- La liste d’autorisation Telegram peut correspondre aux identifiants utilisateur (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) ou aux noms d’utilisateur (`"@alice"` ou `"alice"`) ; les préfixes sont insensibles à la casse.
- La valeur par défaut est `groupPolicy: "allowlist"` ; si votre liste d’autorisation de groupes est vide, les messages de groupe sont bloqués.

Modèle mental rapide (ordre d’évaluation pour les messages de groupe) :

1. `groupPolicy` (open/désactivé/liste d’autorisation)
2. listes d’autorisation de groupe (`*.groups`, `*.groupAllowFrom`, liste spécifique au canal)
3. filtrage par mention (`requireMention`, `/activation`)

## Mentionner la barrière (par défaut)

Les messages de groupe nécessitent une mention, sauf remplacement par groupe. Les valeurs par défaut se trouvent par sous-système sous `*.groups."*"`.

Répondre à un message du bot compte comme une mention implicite (lorsque le canal prend en charge les métadonnées de réponse). Cela s’applique à Telegram, WhatsApp, Slack, Discord et Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Remarques :

- Les `mentionPatterns` sont des regex insensibles à la casse.
- Les surfaces qui fournissent des mentions explicites passent quand même ; les motifs servent de solution de repli.
- Remplacement par agent : `agents.list[].groupChat.mentionPatterns` (utile lorsque plusieurs agents partagent un groupe).
- Le filtrage par mention n’est appliqué que lorsque la détection des mentions est possible (mentions natives ou `mentionPatterns` configurés).
- Les valeurs par défaut Discord se trouvent dans `channels.discord.guilds."*"` (remplaçables par guilde/canal).
- Le contexte d’historique de groupe est encapsulé de manière uniforme sur les canaux et est **en attente uniquement** (messages ignorés en raison du filtrage par mention) ; utilisez `messages.groupChat.historyLimit` pour la valeur globale par défaut et `channels.<channel>.historyLimit` (ou `channels.<channel>.accounts.*.historyLimit`) pour les remplacements. Définissez `0` pour désactiver.

## Restrictions d’outils par groupe/canal (optionnel)

Certaines configurations de canal prennent en charge la restriction des outils disponibles **à l’intérieur d’un groupe/salle/canal spécifique**.

- `tools` : autoriser/refuser des outils pour l’ensemble du groupe.
- `toolsBySender` : remplacements par expéditeur au sein du groupe (les clés sont des identifiants d’expéditeur/noms d’utilisateur/e-mails/numéros de téléphone selon le canal). Utilisez `"*"` comme joker.

Ordre de résolution (le plus spécifique l’emporte) :

1. correspondance `toolsBySender` du groupe/canal
2. `tools` du groupe/canal
3. valeur par défaut (`"*"`) correspondance `toolsBySender`
4. valeur par défaut (`"*"`) `tools`

Exemple (Telegram) :

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Remarques :

- Les restrictions d’outils par groupe/canal s’appliquent en plus de la politique d’outils globale/par agent (le refus l’emporte toujours).
- Certains canaux utilisent une imbrication différente pour les salles/canaux (par ex., Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Listes d’autorisation de groupes

Lorsque `channels.whatsapp.groups`, `channels.telegram.groups` ou `channels.imessage.groups` est configuré, ces clés agissent comme une liste d’autorisation de groupes. Utilisez `"*"` pour autoriser tous les groupes tout en définissant le comportement de mention par défaut.

Intentions courantes (copier/coller) :

1. Désactiver toutes les réponses de groupe

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Autoriser uniquement des groupes spécifiques (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Autoriser tous les groupes mais exiger une mention (explicite)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Seul le propriétaire peut déclencher dans les groupes (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Activation (réservée au propriétaire)

Les propriétaires de groupe peuvent activer/désactiver par groupe :

- `/activation mention`
- `/activation always`

Le propriétaire est déterminé par `channels.whatsapp.allowFrom` (ou l’E.164 du bot lui-même lorsqu’il n’est pas défini). Envoyez la commande en tant que message autonome. Les autres surfaces ignorent actuellement `/activation`.

## Champs de contexte

Les charges utiles entrantes de groupe définissent :

- `ChatType=group`
- `GroupSubject` (si connu)
- `GroupMembers` (si connu)
- `WasMentioned` (résultat du filtrage par mention)
- Les sujets de forum Telegram incluent également `MessageThreadId` et `IsForum`.

L’invite système de l’agent inclut une introduction de groupe au premier tour d’une nouvelle session de groupe. Elle rappelle au modèle de répondre comme un humain, d’éviter les tableaux Markdown et d’éviter de taper littéralement des séquences `\n`.

## Spécificités iMessage

- Préférez `chat_id:<id>` lors du routage ou de la mise en liste d’autorisation.
- Lister les discussions : `imsg chats --limit 20`.
- Les réponses de groupe retournent toujours vers le même `chat_id`.

## Spécificités WhatsApp

Voir [Messages de groupe](/channels/group-messages) pour le comportement propre à WhatsApp (injection d’historique, détails de gestion des mentions).
