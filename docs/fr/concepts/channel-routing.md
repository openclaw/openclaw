---
summary: "Règles de routage par canal (WhatsApp, Telegram, Discord, Slack) et contexte partagé"
read_when:
  - Modification du routage des canaux ou du comportement de la boîte de réception
title: "Routage des canaux"
x-i18n:
  source_path: concepts/channel-routing.md
  source_hash: 1a322b5187e32c82
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:11Z
---

# Canaux et routage

OpenClaw route les réponses **vers le canal d’où provient le message**. Le
modèle ne choisit pas un canal ; le routage est déterministe et contrôlé par la
configuration de l’hôte.

## Termes clés

- **Canal** : `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId** : instance de compte par canal (lorsqu’elle est prise en charge).
- **AgentId** : un espace de travail isolé + un magasin de sessions (« cerveau »).
- **SessionKey** : la clé de compartiment utilisée pour stocker le contexte et contrôler la concurrence.

## Formes de clés de session (exemples)

Les messages privés se regroupent dans la session **principale** de l’agent :

- `agent:<agentId>:<mainKey>` (par défaut : `agent:main:main`)

Les groupes et canaux restent isolés par canal :

- Groupes : `agent:<agentId>:<channel>:group:<id>`
- Canaux/salles : `agent:<agentId>:<channel>:channel:<id>`

Fils de discussion :

- Les fils Slack/Discord ajoutent `:thread:<threadId>` à la clé de base.
- Les sujets de forum Telegram intègrent `:topic:<topicId>` dans la clé de groupe.

Exemples :

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Règles de routage (comment un agent est choisi)

Le routage sélectionne **un agent** pour chaque message entrant :

1. **Correspondance exacte du pair** (`bindings` avec `peer.kind` + `peer.id`).
2. **Correspondance de guilde** (Discord) via `guildId`.
3. **Correspondance d’équipe** (Slack) via `teamId`.
4. **Correspondance de compte** (`accountId` sur le canal).
5. **Correspondance de canal** (n’importe quel compte sur ce canal).
6. **Agent par défaut** (`agents.list[].default`, sinon la première entrée de la liste, repli vers `main`).

L’agent correspondant détermine l’espace de travail et le magasin de sessions utilisés.

## Groupes de diffusion (exécuter plusieurs agents)

Les groupes de diffusion vous permettent d’exécuter **plusieurs agents** pour le même pair **lorsqu’OpenClaw répondrait normalement** (par exemple : dans les groupes WhatsApp, après un contrôle par mention/activation).

Configuration :

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Voir : [Groupes de diffusion](/broadcast-groups).

## Aperçu de la configuration

- `agents.list` : définitions d’agents nommées (espace de travail, modèle, etc.).
- `bindings` : mappe les canaux/comptes/pairs entrants vers des agents.

Exemple :

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

Les magasins de sessions se trouvent sous le répertoire d’état (par défaut `~/.openclaw`) :

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Les transcriptions JSONL se trouvent à côté du magasin

Vous pouvez remplacer le chemin du magasin via le templating `session.store` et `{agentId}`.

## Comportement de WebChat

WebChat s’attache à **l’agent sélectionné** et utilise par défaut la session
principale de l’agent. Pour cette raison, WebChat vous permet de voir le contexte
multi‑canal de cet agent en un seul endroit.

## Contexte de réponse

Les réponses entrantes incluent :

- `ReplyToId`, `ReplyToBody` et `ReplyToSender` lorsque disponibles.
- Le contexte cité est ajouté à `Body` sous forme de bloc `[Replying to ...]`.

Ceci est cohérent sur l’ensemble des canaux.
