---
summary: "Règles de routage par canal (WhatsApp, Telegram, Discord, Slack) et contexte partagé"
read_when:
  - Modification du routage de canal ou comportement de boîte de réception
title: "Routage des Canaux"
---

# Canaux & routage

OpenClaw route les réponses **vers le canal d'où provient le message**. Le modèle ne choisit pas de canal ; le routage est déterministe et contrôlé par la configuration de l'hôte.

## Termes clés

- **Canal** : `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId** : instance de compte par canal (quand supporté).
- **AgentId** : un espace de travail isolé + magasin de session ("cerveau").
- **SessionKey** : la clé de bucket utilisée pour stocker le contexte et contrôler la concurrence.

## Formes de clés de session (exemples)

Les messages directs se replient sur la session **main** de l'agent :

- `agent:<agentId>:<mainKey>` (par défaut : `agent:main:main`)

Les groupes et canaux restent isolés par canal :

- Groupes : `agent:<agentId>:<channel>:group:<id>`
- Canaux/salons : `agent:<agentId>:<channel>:channel:<id>`

Fils de discussion :

- Les fils Slack/Discord ajoutent `:thread:<threadId>` à la clé de base.
- Les sujets de forum Telegram intègrent `:topic:<topicId>` dans la clé de groupe.

Exemples :

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Règles de routage (comment un agent est choisi)

Le routage choisit **un agent** pour chaque message entrant :

1. **Correspondance exacte de pair** (`bindings` avec `peer.kind` + `peer.id`).
2. **Correspondance de pair parent** (héritage de fil).
3. **Correspondance guilde + rôles** (Discord) via `guildId` + `roles`.
4. **Correspondance guilde** (Discord) via `guildId`.
5. **Correspondance équipe** (Slack) via `teamId`.
6. **Correspondance compte** (`accountId` sur le canal).
7. **Correspondance canal** (n'importe quel compte sur ce canal, `accountId: "*"`).
8. **Agent par défaut** (`agents.list[].default`, sinon première entrée de liste, repli sur `main`).

Quand une liaison inclut plusieurs champs de correspondance (`peer`, `guildId`, `teamId`, `roles`), **tous les champs fournis doivent correspondre** pour que cette liaison s'applique.

L'agent correspondant détermine quel espace de travail et magasin de session sont utilisés.

## Groupes de diffusion (exécuter plusieurs agents)

Les groupes de diffusion vous permettent d'exécuter **plusieurs agents** pour le même pair **quand OpenClaw répondrait normalement** (par exemple : dans les groupes WhatsApp, après blocage de mention/activation).

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

Voir : [Groupes de Diffusion](/fr-FR/channels/broadcast-groups).

## Aperçu de la configuration

- `agents.list` : définitions d'agents nommés (espace de travail, modèle, etc.).
- `bindings` : mapper les canaux/comptes/pairs entrants aux agents.

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

## Stockage de session

Les magasins de session vivent sous le répertoire d'état (par défaut `~/.openclaw`) :

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Les transcriptions JSONL vivent à côté du magasin

Vous pouvez remplacer le chemin du magasin via `session.store` et le templating `{agentId}`.

## Comportement WebChat

WebChat s'attache à **l'agent sélectionné** et utilise par défaut la session principale de l'agent. Pour cette raison, WebChat vous permet de voir le contexte inter-canal pour cet agent en un seul endroit.

## Contexte de réponse

Les réponses entrantes incluent :

- `ReplyToId`, `ReplyToBody`, et `ReplyToSender` quand disponibles.
- Le contexte cité est ajouté à `Body` comme un bloc `[Réponse à ...]`.

Ceci est cohérent à travers les canaux.
