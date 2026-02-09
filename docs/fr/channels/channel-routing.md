---
summary: "Règles de routage par canal (WhatsApp, Telegram, Discord, Slack) et contexte partagé"
read_when:
  - Modification du routage des canaux ou du comportement des boîtes de réception
title: "Routage des canaux"
---

# Canaux et routage

OpenClaw route les réponses **vers le canal d’où provient le message**. Le
modèle ne choisit pas de canal ; le routage est déterministe et contrôlé par la
configuration de l’hôte.

## Termes clés

- **Canal** : `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId** : instance de compte par canal (lorsque pris en charge).
- **AgentId** : un espace de travail isolé + un magasin de sessions (« cerveau »).
- **SessionKey** : la clé de compartiment utilisée pour stocker le contexte et contrôler la concurrence.

## Formes de clés de session (exemples)

Les messages privés se regroupent dans la session **principale** de l’agent :

- `agent:<agentId>:<mainKey>` (par défaut : `agent:main:main`)

Les groupes et canaux restent isolés par canal :

- Groupes : `agent:<agentId>:<channel>:group:<id>`
- Canaux/salles : `agent:<agentId>:<channel>:channel:<id>`

Fils de discussion :

- Les fils Slack/Discord ajoutent `:thread:<threadId>` à la clé de base.
- Les sujets de forum Telegram intègrent `:topic:<topicId>` dans la clé de groupe.

Exemples :

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Règles de routage (comment un agent est choisi)

Le routage sélectionne **un agent** pour chaque message entrant :

1. **Correspondance exacte du pair** (`bindings` avec `peer.kind` + `peer.id`).
2. **Correspondance de guilde** (Discord) via `guildId`.
3. **Correspondance d’équipe** (Slack) via `teamId`.
4. **Correspondance de compte** (`accountId` sur le canal).
5. **Correspondance de canal** (n’importe quel compte sur ce canal).
6. **Agent par défaut** (`agents.list[].default`, sinon la première entrée de la liste, repli vers `main`).

L’agent correspondant détermine quel espace de travail et quel magasin de sessions sont utilisés.

## Groupes de diffusion (exécuter plusieurs agents)

Les groupes de diffusion vous permettent d’exécuter **plusieurs agents** pour le même pair **lorsque OpenClaw répondrait normalement** (par exemple : dans des groupes WhatsApp, après un filtrage par mention/activation).

Configuration :

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Voir : [Groupes de diffusion](/channels/broadcast-groups).

## Vue d’ensemble de la configuration

- `agents.list` : définitions d’agents nommées (espace de travail, modèle, etc.).
- `bindings` : associe les canaux/comptes/pairs entrants aux agents.

Exemple :

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Stockage des sessions

Les magasins de sessions se trouvent sous le répertoire d’état (par défaut `~/.openclaw`) :

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Les transcriptions JSONL se trouvent à côté du magasin

Vous pouvez remplacer le chemin du magasin via le templating `session.store` et `{agentId}`.

## Comportement de WebChat

WebChat se rattache à **l’agent sélectionné** et utilise par défaut la session
principale de l’agent. De ce fait, WebChat vous permet de voir le contexte
multicanal de cet agent en un seul endroit.

## Contexte de réponse

Les réponses entrantes incluent :

- `ReplyToId`, `ReplyToBody` et `ReplyToSender` lorsque disponibles.
- Le contexte cité est ajouté à `Body` sous forme de bloc `[Replying to ...]`.

Ceci est cohérent sur l’ensemble des canaux.
