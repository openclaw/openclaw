---
summary: "Routage multi-agents : agents isolés, comptes de canaux et liaisons"
title: Routage multi-agents
read_when: "Vous voulez plusieurs agents isolés (espaces de travail + authentification) dans un processus de passerelle."
status: active
---

# Routage multi-agents

Objectif : plusieurs agents _isolés_ (espace de travail séparé + `agentDir` + sessions), plus plusieurs comptes de canaux (par ex. deux WhatsApps) dans une Passerelle en cours d'exécution. L'entrant est routé vers un agent via des liaisons.

## Qu'est-ce qu'un agent ?

Un **agent** est un cerveau entièrement délimité avec ses propres :

- **Espace de travail** (fichiers, AGENTS.md/SOUL.md/USER.md, notes locales, règles de personnalité).
- **Répertoire d'état** (`agentDir`) pour les profils d'authentification, le registre de modèles et la config par agent.
- **Magasin de session** (historique de chat + état de routage) sous `~/.openclaw/agents/<agentId>/sessions`.

Les profils d'authentification sont **par agent**. Chaque agent lit depuis son propre :

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Les identifiants de l'agent principal ne sont **pas** partagés automatiquement. Ne réutilisez jamais `agentDir`
entre agents (cela cause des collisions d'authentification/session). Si vous voulez partager des identifiants,
copiez `auth-profiles.json` dans l'`agentDir` de l'autre agent.

Les compétences sont par agent via le dossier `skills/` de chaque espace de travail, avec les compétences partagées
disponibles depuis `~/.openclaw/skills`. Voir [Skills: per-agent vs shared](/fr-FR/tools/skills#per-agent-vs-shared-skills).

La Passerelle peut héberger **un agent** (par défaut) ou **plusieurs agents** côte à côte.

**Note sur l'espace de travail :** l'espace de travail de chaque agent est le **cwd par défaut**, pas un bac à
sable dur. Les chemins relatifs se résolvent dans l'espace de travail, mais les chemins absolus peuvent
atteindre d'autres emplacements hôtes sauf si le sandboxing est activé. Voir
[Sandboxing](/fr-FR/gateway/sandboxing).

## Chemins (carte rapide)

- Config : `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)
- Répertoire d'état : `~/.openclaw` (ou `OPENCLAW_STATE_DIR`)
- Espace de travail : `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<agentId>`)
- Répertoire d'agent : `~/.openclaw/agents/<agentId>/agent` (ou `agents.list[].agentDir`)
- Sessions : `~/.openclaw/agents/<agentId>/sessions`

### Mode agent unique (par défaut)

Si vous ne faites rien, OpenClaw exécute un seul agent :

- `agentId` par défaut est **`main`**.
- Les sessions sont indexées comme `agent:main:<mainKey>`.
- L'espace de travail par défaut est `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<profile>` quand `OPENCLAW_PROFILE` est défini).
- L'état par défaut est `~/.openclaw/agents/main/agent`.

## Aide agent

Utilisez l'assistant agent pour ajouter un nouvel agent isolé :

```bash
openclaw agents add work
```

Puis ajoutez des `bindings` (ou laissez l'assistant le faire) pour router les messages entrants.

Vérifiez avec :

```bash
openclaw agents list --bindings
```

## Plusieurs agents = plusieurs personnes, plusieurs personnalités

Avec **plusieurs agents**, chaque `agentId` devient une **personnalité entièrement isolée** :

- **Différents numéros de téléphone/comptes** (par `accountId` de canal).
- **Différentes personnalités** (fichiers d'espace de travail par agent comme `AGENTS.md` et `SOUL.md`).
- **Authentification + sessions séparées** (pas de discussion croisée sauf si explicitement activée).

Cela permet à **plusieurs personnes** de partager un serveur Passerelle tout en gardant leurs "cerveaux" IA et données isolés.

## Un numéro WhatsApp, plusieurs personnes (division DM)

Vous pouvez router **différents DMs WhatsApp** vers différents agents tout en restant sur **un compte WhatsApp**. Correspondez sur l'expéditeur E.164 (comme `+15551234567`) avec `peer.kind: "direct"`. Les réponses viennent toujours du même numéro WhatsApp (pas d'identité d'expéditeur par agent).

Détail important : les chats directs se replient vers la **clé de session principale** de l'agent, donc la vraie isolation nécessite **un agent par personne**.

Exemple :

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Notes :

- Le contrôle d'accès DM est **global par compte WhatsApp** (appairage/liste blanche), pas par agent.
- Pour les groupes partagés, liez le groupe à un agent ou utilisez [Groupes de diffusion](/fr-FR/channels/broadcast-groups).

## Règles de routage (comment les messages choisissent un agent)

Les liaisons sont **déterministes** et **le plus spécifique gagne** :

1. Correspondance `peer` (ID DM/groupe/canal exact)
2. Correspondance `parentPeer` (héritage de fil)
3. `guildId + roles` (routage de rôle Discord)
4. `guildId` (Discord)
5. `teamId` (Slack)
6. Correspondance `accountId` pour un canal
7. Correspondance au niveau du canal (`accountId: "*"`)
8. Repli vers l'agent par défaut (`agents.list[].default`, sinon première entrée de liste, par défaut : `main`)

Si une liaison définit plusieurs champs de correspondance (par exemple `peer` + `guildId`), tous les champs spécifiés sont requis (sémantique `AND`).

## Plusieurs comptes / numéros de téléphone

Les canaux qui supportent **plusieurs comptes** (par ex. WhatsApp) utilisent `accountId` pour identifier
chaque connexion. Chaque `accountId` peut être routé vers un agent différent, donc un serveur peut héberger
plusieurs numéros de téléphone sans mélanger les sessions.

## Concepts

- `agentId` : un "cerveau" (espace de travail, authentification par agent, magasin de session par agent).
- `accountId` : une instance de compte de canal (par ex. compte WhatsApp `"personal"` vs `"biz"`).
- `binding` : route les messages entrants vers un `agentId` par `(channel, accountId, peer)` et optionnellement ids guild/team.
- Les chats directs se replient vers `agent:<agentId>:<mainKey>` (par agent "main" ; `session.mainKey`).

## Exemple : deux WhatsApps → deux agents

`~/.openclaw/openclaw.json` (JSON5) :

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Routage déterministe : première correspondance gagne (plus spécifique en premier).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Remplacement par pair optionnel (exemple : envoyer un groupe spécifique vers l'agent work).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Désactivé par défaut : la messagerie agent-à-agent doit être explicitement activée + mise en liste blanche.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Remplacement optionnel. Par défaut : ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Remplacement optionnel. Par défaut : ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Exemple : chat quotidien WhatsApp + travail profond Telegram

Diviser par canal : router WhatsApp vers un agent quotidien rapide et Telegram vers un agent Opus.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Notes :

- Si vous avez plusieurs comptes pour un canal, ajoutez `accountId` à la liaison (par exemple `{ channel: "whatsapp", accountId: "personal" }`).
- Pour router un seul DM/groupe vers Opus tout en gardant le reste sur chat, ajoutez une liaison `match.peer` pour ce pair ; les correspondances de pair gagnent toujours sur les règles à l'échelle du canal.

## Exemple : même canal, un pair vers Opus

Gardez WhatsApp sur l'agent rapide, mais routez un DM vers Opus :

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Les liaisons de pair gagnent toujours, donc gardez-les au-dessus de la règle à l'échelle du canal.

## Agent familial lié à un groupe WhatsApp

Liez un agent familial dédié à un seul groupe WhatsApp, avec contrôle de mention
et une politique d'outil plus stricte :

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Notes :

- Les listes allow/deny d'outils sont des **outils**, pas des compétences. Si une compétence a besoin d'exécuter un
  binaire, assurez-vous que `exec` est autorisé et que le binaire existe dans le sandbox.
- Pour un contrôle plus strict, définissez `agents.list[].groupChat.mentionPatterns` et gardez
  les listes blanches de groupe activées pour le canal.

## Configuration de sandbox et d'outil par agent

Depuis la v2026.1.6, chaque agent peut avoir son propre sandbox et restrictions d'outil :

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // Pas de sandbox pour l'agent personnel
        },
        // Pas de restrictions d'outil - tous les outils disponibles
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Toujours en sandbox
          scope: "agent",  // Un conteneur par agent
          docker: {
            // Configuration unique optionnelle après création du conteneur
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Seulement l'outil read
          deny: ["exec", "write", "edit", "apply_patch"],    // Refuser les autres
        },
      },
    ],
  },
}
```

Note : `setupCommand` vit sous `sandbox.docker` et s'exécute une fois à la création du conteneur.
Les remplacements `sandbox.docker.*` par agent sont ignorés quand le scope résolu est `"shared"`.

**Avantages :**

- **Isolation de sécurité** : Restreindre les outils pour les agents non fiables
- **Contrôle des ressources** : sandbox pour des agents spécifiques tout en gardant les autres sur l'hôte
- **Politiques flexibles** : Différentes permissions par agent

Note : `tools.elevated` est **global** et basé sur l'expéditeur ; il n'est pas configurable par agent.
Si vous avez besoin de limites par agent, utilisez `agents.list[].tools` pour refuser `exec`.
Pour le ciblage de groupe, utilisez `agents.list[].groupChat.mentionPatterns` pour que les @mentions mappent proprement vers l'agent visé.

Voir [Multi-Agent Sandbox & Tools](/fr-FR/tools/multi-agent-sandbox-tools) pour des exemples détaillés.
