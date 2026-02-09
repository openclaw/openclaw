---
summary: "Routage multi-agent : agents isolés, comptes de canal et liaisons"
title: Routage multi-agent
read_when: "Vous souhaitez plusieurs agents isolés (espaces de travail + authentification) dans un seul processus de Gateway."
status: active
---

# Routage multi-agent

Objectif : plusieurs agents _isolés_ (espace de travail distinct + `agentDir` + sessions), ainsi que plusieurs comptes de canal (par ex. deux WhatsApps) dans une seule Gateway en cours d’exécution. Le trafic entrant est routé vers un agent via des liaisons.

## Qu’est-ce qu’« un agent » ?

Un **agent** est un cerveau entièrement délimité avec ses propres éléments :

- **Espace de travail** (fichiers, AGENTS.md/SOUL.md/USER.md, notes locales, règles de persona).
- **Répertoire d’état** (`agentDir`) pour les profils d’authentification, le registre des modèles et la configuration par agent.
- **Magasin de sessions** (historique de chat + état de routage) sous `~/.openclaw/agents/<agentId>/sessions`.

Les profils d’authentification sont **par agent**. Chaque agent lit depuis son propre :

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Les identifiants de l’agent principal ne sont **pas** partagés automatiquement. Ne réutilisez jamais `agentDir`
entre agents (cela provoque des collisions d’authentification/de session). Si vous souhaitez partager des identifiants,
copiez `auth-profiles.json` dans le `agentDir` de l’autre agent.

Les Skills sont par agent via le dossier `skills/` de chaque espace de travail, avec des Skills partagés
disponibles depuis `~/.openclaw/skills`. Voir [Skills : par agent vs partagés](/tools/skills#per-agent-vs-shared-skills).

La Gateway peut héberger **un agent** (par défaut) ou **plusieurs agents** côte à côte.

**Note sur l’espace de travail :** l’espace de travail de chaque agent est le **cwd par défaut**, et non un
sandbox strict. Les chemins relatifs se résolvent dans l’espace de travail, mais les chemins absolus peuvent
atteindre d’autres emplacements de l’hôte à moins que le sandboxing ne soit activé. Voir
[Sandboxing](/gateway/sandboxing).

## Chemins (carte rapide)

- Configuration : `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)
- Répertoire d’état : `~/.openclaw` (ou `OPENCLAW_STATE_DIR`)
- Espace de travail : `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<agentId>`)
- Répertoire de l’agent : `~/.openclaw/agents/<agentId>/agent` (ou `agents.list[].agentDir`)
- Sessions : `~/.openclaw/agents/<agentId>/sessions`

### Mode agent unique (par défaut)

Si vous ne faites rien, OpenClaw exécute un seul agent :

- `agentId` par défaut vaut **`main`**.
- Les sessions sont indexées comme `agent:main:<mainKey>`.
- L’espace de travail par défaut est `~/.openclaw/workspace` (ou `~/.openclaw/workspace-<profile>` lorsque `OPENCLAW_PROFILE` est défini).
- L’état par défaut est `~/.openclaw/agents/main/agent`.

## Assistant d’agent

Utilisez l’assistant d’agent pour ajouter un nouvel agent isolé :

```bash
openclaw agents add work
```

Ajoutez ensuite `bindings` (ou laissez l’assistant le faire) pour router les messages entrants.

Vérifiez avec :

```bash
openclaw agents list --bindings
```

## Plusieurs agents = plusieurs personnes, plusieurs personnalités

Avec **plusieurs agents**, chaque `agentId` devient une **persona entièrement isolée** :

- **Numéros de téléphone/comptes différents** (par canal `accountId`).
- **Personnalités différentes** (fichiers d’espace de travail par agent comme `AGENTS.md` et `SOUL.md`).
- **Authentification + sessions séparées** (aucun chevauchement sauf activation explicite).

Cela permet à **plusieurs personnes** de partager un même serveur Gateway tout en gardant leurs « cerveaux » IA et données isolés.

## Un numéro WhatsApp, plusieurs personnes (répartition des Messages prives)

Vous pouvez router **différents Messages prives WhatsApp** vers différents agents tout en restant sur **un seul compte WhatsApp**. Faites correspondre l’expéditeur E.164 (comme `+15551234567`) avec `peer.kind: "dm"`. Les réponses proviennent toujours du même numéro WhatsApp (pas d’identité d’expéditeur par agent).

Détail important : les discussions directes se regroupent sous la **clé de session principale** de l’agent, donc une isolation réelle nécessite **un agent par personne**.

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
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
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

- Le contrôle d’accès aux Messages prives est **global par compte WhatsApp** (appairage/liste d’autorisation), pas par agent.
- Pour les groupes partagés, liez le groupe à un agent ou utilisez les [Groupes de diffusion](/broadcast-groups).

## Règles de routage (comment les messages choisissent un agent)

Les liaisons sont **déterministes** et **la plus spécifique l’emporte** :

1. Correspondance `peer` (ID exact de Message prive/groupe/canal)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. Correspondance `accountId` pour un canal
5. Correspondance au niveau du canal (`accountId: "*"`)
6. Repli vers l’agent par défaut (`agents.list[].default`, sinon la première entrée de la liste, valeur par défaut : `main`)

## Comptes / numéros multiples

Les canaux prenant en charge **plusieurs comptes** (par ex. WhatsApp) utilisent `accountId` pour identifier
chaque connexion. Chaque `accountId` peut être routé vers un agent différent, de sorte qu’un seul serveur peut héberger
plusieurs numéros de téléphone sans mélanger les sessions.

## Concepts

- `agentId` : un « cerveau » (espace de travail, authentification par agent, magasin de sessions par agent).
- `accountId` : une instance de compte de canal (par ex. compte WhatsApp `"personal"` vs `"biz"`).
- `binding` : route les messages entrants vers un `agentId` par `(channel, accountId, peer)` et éventuellement par identifiants de guilde/équipe.
- Les discussions directes se regroupent vers `agent:<agentId>:<mainKey>` (« principal » par agent ; `session.mainKey`).

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

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
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
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Exemple : discussion quotidienne WhatsApp + travail approfondi Telegram

Séparation par canal : routez WhatsApp vers un agent rapide du quotidien et Telegram vers un agent Opus.

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
- Pour router un seul Message prive/groupe vers Opus tout en gardant le reste sur le chat, ajoutez une liaison `match.peer` pour ce pair ; les correspondances de pair l’emportent toujours sur les règles à l’échelle du canal.

## Exemple : même canal, un pair vers Opus

Conservez WhatsApp sur l’agent rapide, mais routez un Message prive vers Opus :

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
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Les liaisons de pair l’emportent toujours ; conservez-les donc au-dessus de la règle à l’échelle du canal.

## Agent familial lié à un groupe WhatsApp

Liez un agent familial dédié à un seul groupe WhatsApp, avec un contrôle par mentions
et une politique d’outils plus restrictive :

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

- Les listes d’autorisation/refus d’outils concernent les **outils**, pas les Skills. Si un Skill doit exécuter un
  binaire, assurez-vous que `exec` est autorisé et que le binaire existe dans le sandbox.
- Pour un contrôle plus strict, définissez `agents.list[].groupChat.mentionPatterns` et conservez
  les listes d’autorisation de groupe activées pour le canal.

## Sandbox et configuration des outils par agent

À partir de la version v2026.1.6, chaque agent peut avoir son propre sandbox et ses propres restrictions d’outils :

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

Remarque : `setupCommand` se trouve sous `sandbox.docker` et s’exécute une seule fois lors de la création du conteneur.
Les surcharges `sandbox.docker.*` par agent sont ignorées lorsque la portée résolue est `"shared"`.

**Avantages :**

- **Isolation de sécurité** : restreindre les outils pour les agents non fiables
- **Contrôle des ressources** : mettre certains agents en sandbox tout en conservant les autres sur l’hôte
- **Politiques flexibles** : permissions différentes par agent

Remarque : `tools.elevated` est **global** et basé sur l’expéditeur ; il n’est pas configurable par agent.
Si vous avez besoin de frontières par agent, utilisez `agents.list[].tools` pour refuser `exec`.
Pour le ciblage de groupe, utilisez `agents.list[].groupChat.mentionPatterns` afin que les @mentions correspondent clairement à l’agent prévu.

Voir [Sandbox et outils multi-agent](/multi-agent-sandbox-tools) pour des exemples détaillés.
