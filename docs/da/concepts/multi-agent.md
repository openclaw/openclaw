---
summary: "Multi-agent-routing: isolerede agenter, kanalkonti og bindinger"
title: Multi-Agent-routing
read_when: "Du vil have flere isolerede agenter (workspaces + auth) i én gateway-proces."
status: active
---

# Multi-Agent-routing

Mål: flere _isolated_ agenter (separate arbejdsrum + `agentDir` + sessioner), plus flere kanalkonti (f.eks. to WhatsApps) i en kørende Gateway. Indgående sendes til en agent via bindinger.

## Hvad er “én agent”?

En **agent** er en fuldt afgrænset hjerne med sin egen:

- **Workspace** (filer, AGENTS.md/SOUL.md/USER.md, lokale noter, personaregler).
- **Tilstandskatalog** (`agentDir`) til auth-profiler, modelregister og per-agent konfiguration.
- **Session-lager** (chathistorik + routingtilstand) under `~/.openclaw/agents/<agentId>/sessions`.

Auth profiler er **per-agent**. Hver agent læser fra sig selv:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Hovedagent legitimationsoplysninger **ikke** deles automatisk. Genbrug aldrig 'agentDir'
på tværs af agenter (det forårsager auth/session kollisioner). Hvis du ønsker at dele creds,
kopiere `auth-profiles.json` til den anden agent's `agentDir`.

Færdigheder er per-agent via hvert arbejdsområde `færdigheder/` mappe, med delte færdigheder
til rådighed fra `~/.openclaw/skills`. Se [Færdigheder: per-agent vs delt](/tools/skills#per-agent-vs-shared-skills).

Gateway kan hoste **én agent** (standard) eller **mange agenter** side om side.

**Arbejdsrum note:** hver agents arbejdsområde er **standard cwd**, ikke en hård
sandkasse. Relative stier løser inde i arbejdsområdet, men absolutte stier kan
nå andre værtssteder, medmindre sandboxing er aktiveret. Se
[Sandboxing](/gateway/sandboxing)

## Stier (hurtigt overblik)

- Konfiguration: `~/.openclaw/openclaw.json` (eller `OPENCLAW_CONFIG_PATH`)
- Tilstandskatalog: `~/.openclaw` (eller `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (eller `~/.openclaw/workspace-<agentId>`)
- Agent-katalog: `~/.openclaw/agents/<agentId>/agent` (eller `agents.list[].agentDir`)
- Sessioner: `~/.openclaw/agents/<agentId>/sessions`

### Single-agent-tilstand (standard)

Hvis du ikke gør noget, kører OpenClaw med én agent:

- `agentId` er som standard **`main`**.
- Sessioner nøgles som `agent:main:<mainKey>`.
- Workspace er som standard `~/.openclaw/workspace` (eller `~/.openclaw/workspace-<profile>` når `OPENCLAW_PROFILE` er sat).
- Tilstand er som standard `~/.openclaw/agents/main/agent`.

## Agent-hjælper

Brug agent-wizarden til at tilføje en ny isoleret agent:

```bash
openclaw agents add work
```

Tilføj derefter `bindings` (eller lad wizarden gøre det) for at route indgående beskeder.

Verificér med:

```bash
openclaw agents list --bindings
```

## Flere agenter = flere personer, flere personligheder

Med **flere agenter** bliver hver `agentId` en **fuldt isoleret persona**:

- **Forskellige telefonnumre/konti** (per kanal `accountId`).
- **Forskellige personligheder** (per-agent workspace-filer som `AGENTS.md` og `SOUL.md`).
- **Adskilt auth + sessioner** (ingen krydstale, medmindre det eksplicit er aktiveret).

Det gør det muligt for **flere personer** at dele én Gateway-server, mens deres AI-“hjerner” og data forbliver isolerede.

## Ét WhatsApp-nummer, flere personer (DM-split)

Du kan dirigere **forskellige WhatsApp DMs** til forskellige agenter under opholdet på **one WhatsApp account**. Match på afsender E.164 (som `+15551234567`) med `peer.kind: "dm"`. Svar kommer stadig fra det samme WhatsApp nummer (ingen per-agent afsender identitet).

Vigtig detalje: direkte chats kollapser til agentens **hovedsessionsnøgle**, så ægte isolation kræver **én agent per person**.

Eksempel:

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

Noter:

- DM-adgangskontrol er **global per WhatsApp-konto** (parring/tilladelsesliste), ikke per agent.
- For delte grupper: bind gruppen til én agent eller brug [Broadcast groups](/channels/broadcast-groups).

## Routingregler (hvordan beskeder vælger en agent)

Bindinger er **deterministiske**, og **mest specifik vinder**:

1. `peer`-match (præcis DM/gruppe/kanal-id)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. `accountId`-match for en kanal
5. match på kanalniveau (`accountId: "*"`)
6. fallback til standardagent (`agents.list[].default`, ellers første listeindgang, standard: `main`)

## Flere konti / telefonnumre

Kanaler der understøtter **flere konti** (f.eks. WhatsApp) bruger `accountId` til at identificere
hvert login. Hver `accountId` kan dirigeres til en anden agent, så en server kan være vært
flere telefonnumre uden at blande sessioner.

## Begreber

- `agentId`: én “hjerne” (workspace, per-agent auth, per-agent session-lager).
- `accountId`: en kanal konto instans (f.eks. WhatsApp konto `"personal"` vs `"biz"`).
- `binding`: ruter indgående beskeder til en `agentId` af `(kanal, accountId, peer)` og eventuelt guild/team ids.
- Direkte chats kollapser til `agent:<agentId>:<mainKey>` (per-agent “main”; `session.mainKey`).

## Eksempel: to WhatsApps → to agenter

`~/.openclaw/openclaw.json` (JSON5):

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

## Eksempel: WhatsApp daglig chat + Telegram deep work

Opdel efter kanal: route WhatsApp til en hurtig hverdagsagent og Telegram til en Opus-agent.

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

Noter:

- Hvis du har flere konti for en kanal, så tilføj `accountId` til bindingen (for eksempel `{ channel: "whatsapp", accountId: "personal" }`).
- For at route én enkelt DM/gruppe til Opus, mens resten forbliver på chat, tilføj en `match.peer`-binding for den peer; peer-matches vinder altid over kanal-dækkende regler.

## Eksempel: samme kanal, én peer til Opus

Behold WhatsApp på den hurtige agent, men route én DM til Opus:

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

Peer-bindinger vinder altid, så behold dem over den kanal-dækkende regel.

## Familie-agent bundet til en WhatsApp-gruppe

Bind en dedikeret familie-agent til én WhatsApp-gruppe med mention-gating
og en strammere værktøjspolitik:

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

Noter:

- Værktøjet tillad/benægte lister er **værktøjer**, ikke færdigheder. Hvis en færdighed skal køre en
  binær, skal du sikre at `exec` er tilladt, og den binære findes i sandkassen.
- For strengere gating: sæt `agents.list[].groupChat.mentionPatterns` og behold
  gruppe-tilladelseslister aktiveret for kanalen.

## Per-agent Sandbox og værktøjskonfiguration

Fra og med v2026.1.6 kan hver agent have sin egen sandbox og værktøjsbegrænsninger:

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

Bemærk: `setupCommand` lever under `sandbox.docker` og kører én gang på container oprettelse.
Per-agent `sandbox.docker.*` tilsidesættelser ignoreres, når det løste anvendelsesområde er `"delt"`.

**Fordele:**

- **Sikkerhedsisolering**: Begræns værktøjer for utroværdige agenter
- **Ressourcestyring**: Sandbox specifikke agenter, mens andre forbliver på værten
- **Fleksible politikker**: Forskellige tilladelser per agent

Bemærk: `tools.elevated` er **global** og afsenderbaseret; den kan ikke konfigureres pr. agent.
Hvis du har brug for per-agent grænser, brug `agents.list[].tools` at benægte `exec`.
For gruppemål, brug `agents.list[].groupChat.mentionPatterns` så @nævner kort rent til den tilsigtede agent.

Se [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for detaljerede eksempler.
