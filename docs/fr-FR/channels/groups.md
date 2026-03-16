---
summary: "Comportement de chat de groupe sur toutes les surfaces (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Changement du comportement de chat de groupe ou contrôle de mention
title: "Groupes"
---

# Groupes

OpenClaw traite les chats de groupe de manière cohérente sur toutes les surfaces : WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Introduction débutant (2 minutes)

OpenClaw "vit" sur vos propres comptes de messagerie. Il n'y a pas d'utilisateur bot WhatsApp séparé.
Si **vous** êtes dans un groupe, OpenClaw peut voir ce groupe et y répondre.

Comportement par défaut :

- Les groupes sont restreints (`groupPolicy: "allowlist"`).
- Les réponses nécessitent une mention sauf si vous désactivez explicitement le contrôle de mention.

Traduction : les expéditeurs autorisés peuvent déclencher OpenClaw en le mentionnant.

> TL;DR
>
> - **L'accès DM** est contrôlé par `*.allowFrom`.
> - **L'accès groupe** est contrôlé par `*.groupPolicy` + allowlists (`*.groups`, `*.groupAllowFrom`).
> - **Le déclenchement de réponse** est contrôlé par contrôle de mention (`requireMention`, `/activation`).

Flux rapide (que se passe-t-il pour un message de groupe) :

```
groupPolicy? disabled -> abandonner
groupPolicy? allowlist -> groupe autorisé? non -> abandonner
requireMention? oui -> mentionné? non -> stocker pour contexte uniquement
sinon -> répondre
```

![Flux de message de groupe](/images/groups-flow.svg)

Si vous voulez...

| Objectif                                                         | Quoi définir                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Autoriser tous les groupes mais répondre seulement sur @mentions | `groups: { "*": { requireMention: true } }`                |
| Désactiver toutes les réponses de groupe                         | `groupPolicy: "disabled"`                                  |
| Seulement des groupes spécifiques                                | `groups: { "<group-id>": { ... } }` (pas de clé `"*"`)     |
| Seulement vous pouvez déclencher dans les groupes                | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## Clés de session

- Les sessions de groupe utilisent des clés de session `agent:<agentId>:<channel>:group:<id>` (les salons/canaux utilisent `agent:<agentId>:<channel>:channel:<id>`).
- Les sujets de forum Telegram ajoutent `:topic:<threadId>` à l'id du groupe pour que chaque sujet ait sa propre session.
- Les chats directs utilisent la session principale (ou par expéditeur si configuré).
- Les battements de cœur sont ignorés pour les sessions de groupe.

## Modèle : DM personnels + groupes publics (agent unique)

Oui — cela fonctionne bien si votre trafic "personnel" est des **DM** et votre trafic "public" est des **groupes**.

Pourquoi : en mode agent unique, les DM atterrissent généralement dans la clé de session **principale** (`agent:main:main`), tandis que les groupes utilisent toujours des clés de session **non-principales** (`agent:main:<channel>:group:<id>`). Si vous activez le sandboxing avec `mode: "non-main"`, ces sessions de groupe s'exécutent dans Docker tandis que votre session DM principale reste sur l'hôte.

Cela vous donne un "cerveau" d'agent (espace de travail partagé + mémoire), mais deux postures d'exécution :

- **DM** : outils complets (hôte)
- **Groupes** : sandbox + outils restreints (Docker)

> Si vous avez besoin d'espaces de travail/personas vraiment séparés ("personnel" et "public" ne doivent jamais se mélanger), utilisez un second agent + liaisons. Voir [Routage Multi-Agent](/fr-FR/concepts/multi-agent).

Exemple (DM sur hôte, groupes sandboxés + outils messagerie uniquement) :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groupes/canaux sont non-main -> sandboxés
        scope: "session", // isolation la plus forte (un conteneur par groupe/canal)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // Si allow est non-vide, tout le reste est bloqué (deny gagne toujours).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Vous voulez "les groupes peuvent seulement voir le dossier X" au lieu de "pas d'accès hôte" ? Gardez `workspaceAccess: "none"` et montez seulement les chemins autorisés dans le sandbox :

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
            "~/AmisPartagés:/data:ro",
          ],
        },
      },
    },
  },
}
```

Lié :

- Clés de configuration et valeurs par défaut : [Configuration de Passerelle](/fr-FR/gateway/configuration#agentsdefaultssandbox)
- Débogage pourquoi un outil est bloqué : [Sandbox vs Politique d'Outil vs Élevé](/fr-FR/gateway/sandbox-vs-tool-policy-vs-elevated)
- Détails montages bind : [Sandboxing](/fr-FR/gateway/sandboxing#custom-bind-mounts)

## Étiquettes d'affichage

- Les étiquettes UI utilisent `displayName` quand disponible, formaté comme `<channel>:<token>`.
- `#room` est réservé pour salons/canaux ; les chats de groupe utilisent `g-<slug>` (minuscules, espaces -> `-`, garder `#@+._-`).

## Politique de groupe

Contrôlez comment les messages de groupe/salon sont gérés par canal :

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // id utilisateur Telegram numérique (wizard peut résoudre @username)
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
      groupAllowFrom: ["utilisateur@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { aide: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@proprio:exemple.org"],
      groups: {
        "!roomId:exemple.org": { allow: true },
        "#alias:exemple.org": { allow: true },
      },
    },
  },
}
```

| Politique     | Comportement                                                                       |
| ------------- | ---------------------------------------------------------------------------------- |
| `"open"`      | Les groupes contournent les allowlists ; contrôle de mention s'applique toujours.  |
| `"disabled"`  | Bloquer tous les messages de groupe entièrement.                                   |
| `"allowlist"` | Autoriser seulement les groupes/salons qui correspondent à l'allowlist configurée. |

Notes :

- `groupPolicy` est séparé du contrôle de mention (qui nécessite des @mentions).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams : utilisent `groupAllowFrom` (repli : `allowFrom` explicite).
- Discord : allowlist utilise `channels.discord.guilds.<id>.channels`.
- Slack : allowlist utilise `channels.slack.channels`.
- Matrix : allowlist utilise `channels.matrix.groups` (IDs de salon, alias, ou noms). Utilisez `channels.matrix.groupAllowFrom` pour restreindre les expéditeurs ; les allowlists `users` par salon sont aussi supportées.
- Les DM de groupe sont contrôlés séparément (`channels.discord.dm.*`, `channels.slack.dm.*`).
- L'allowlist Telegram peut correspondre aux IDs utilisateur (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) ou noms d'utilisateur (`"@alice"` ou `"alice"`) ; les préfixes sont insensibles à la casse.
- Par défaut c'est `groupPolicy: "allowlist"` ; si votre allowlist de groupe est vide, les messages de groupe sont bloqués.

Modèle mental rapide (ordre d'évaluation pour messages de groupe) :

1. `groupPolicy` (open/disabled/allowlist)
2. allowlists de groupe (`*.groups`, `*.groupAllowFrom`, allowlist spécifique au canal)
3. contrôle de mention (`requireMention`, `/activation`)

## Contrôle de mention (par défaut)

Les messages de groupe nécessitent une mention sauf remplacement par groupe. Les valeurs par défaut vivent par sous-système sous `*.groups."*"`.

Répondre à un message du bot compte comme une mention implicite (quand le canal supporte les métadonnées de réponse). Cela s'applique à Telegram, WhatsApp, Slack, Discord, et Microsoft Teams.

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

Notes :

- `mentionPatterns` sont des regex insensibles à la casse.
- Les surfaces qui fournissent des mentions explicites passent toujours ; les motifs sont un repli.
- Remplacement par agent : `agents.list[].groupChat.mentionPatterns` (utile quand plusieurs agents partagent un groupe).
- Le contrôle de mention est seulement appliqué quand la détection de mention est possible (mentions natives ou `mentionPatterns` sont configurés).
- Les valeurs par défaut Discord vivent dans `channels.discord.guilds."*"` (remplaçable par guilde/canal).
- Le contexte d'historique de groupe est enveloppé uniformément sur tous les canaux et est **pending-only** (messages ignorés en raison du contrôle de mention) ; utilisez `messages.groupChat.historyLimit` pour la valeur par défaut globale et `channels.<channel>.historyLimit` (ou `channels.<channel>.accounts.*.historyLimit`) pour les remplacements. Définir `0` pour désactiver.

## Restrictions d'outil de groupe/canal (optionnel)

Certaines configs de canal supportent la restriction de quels outils sont disponibles **dans un groupe/salon/canal spécifique**.

- `tools` : autoriser/refuser les outils pour tout le groupe.
- `toolsBySender` : remplacements par expéditeur dans le groupe (les clés sont IDs expéditeur/noms d'utilisateur/emails/numéros de téléphone selon le canal). Utilisez `"*"` comme joker.

Ordre de résolution (le plus spécifique gagne) :

1. correspondance `toolsBySender` groupe/canal
2. `tools` groupe/canal
3. correspondance `toolsBySender` par défaut (`"*"`)
4. `tools` par défaut (`"*"`)

Exemple (Telegram) :

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

Notes :

- Les restrictions d'outil de groupe/canal sont appliquées en plus de la politique d'outil globale/agent (deny gagne toujours).
- Certains canaux utilisent une imbrication différente pour salons/canaux (ex., Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Allowlists de groupe

Quand `channels.whatsapp.groups`, `channels.telegram.groups`, ou `channels.imessage.groups` est configuré, les clés agissent comme une allowlist de groupe. Utilisez `"*"` pour autoriser tous les groupes tout en définissant toujours le comportement de mention par défaut.

Intentions communes (copier/coller) :

1. Désactiver toutes les réponses de groupe

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Autoriser seulement des groupes spécifiques (WhatsApp)

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

3. Autoriser tous les groupes mais nécessiter mention (explicite)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Seulement le propriétaire peut déclencher dans les groupes (WhatsApp)

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

## Activation (propriétaire uniquement)

Les propriétaires de groupe peuvent basculer l'activation par groupe :

- `/activation mention`
- `/activation always`

Le propriétaire est déterminé par `channels.whatsapp.allowFrom` (ou le E.164 propre du bot quand non défini). Envoyez la commande comme un message autonome. Les autres surfaces ignorent actuellement `/activation`.

## Champs de contexte

Les charges utiles entrantes de groupe définissent :

- `ChatType=group`
- `GroupSubject` (si connu)
- `GroupMembers` (si connu)
- `WasMentioned` (résultat contrôle de mention)
- Les sujets de forum Telegram incluent aussi `MessageThreadId` et `IsForum`.

Le prompt système de l'agent inclut une intro de groupe au premier tour d'une nouvelle session de groupe. Elle rappelle au modèle de répondre comme un humain, d'éviter les tables Markdown, et d'éviter de taper des séquences littérales `\n`.

## Spécificités iMessage

- Préférez `chat_id:<id>` lors du routage ou de la mise en allowlist.
- Listez les chats : `imsg chats --limit 20`.
- Les réponses de groupe retournent toujours au même `chat_id`.

## Spécificités WhatsApp

Voir [Messages de groupe](/fr-FR/channels/group-messages) pour le comportement WhatsApp uniquement (injection d'historique, détails de gestion de mention).
