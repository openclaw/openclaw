---
summary: "Multi-agent-routning: isolerade agenter, kanalkonton och bindningar"
title: Multi-Agent-routning
read_when: "Du vill ha flera isolerade agenter (arbetsytor + autentisering) i en gateway-process."
status: active
---

# Multi-Agent-routning

Mål: flera _isolerade_ agenter (separat arbetsyta + `agentDir` + sessioner), plus flera kanalkonton (t.ex. två WhatsApps) i en kör Gateway. Inkommande dirigeras till en agent via bindningar.

## Vad är ”en agent”?

En **agent** är ett fullt avgränsat ”hjärna”-system med egna:

- **Arbetsyta** (filer, AGENTS.md/SOUL.md/USER.md, lokala anteckningar, personaregler).
- **Tillståndskatalog** (`agentDir`) för autentiseringsprofiler, modellregister och per-agent-konfig.
- **Sessionslager** (chathistorik + routningstillstånd) under `~/.openclaw/agents/<agentId>/sessions`.

Auth profiler är **per agent**. Varje agent läser från sin egen:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Referenser för huvudagent **inte** delas automatiskt. Återanvänd aldrig `agentDir`
över agenter (det orsakar författ/session kollisioner). Om du vill dela kredit kopierar
`auth-profiles.json` till den andra agentens `agentDir`.

Färdigheter är per agent via varje arbetsytans `skills/`-mapp, med delade färdigheter
tillgängliga från `~/.openclaw/skills`. Se [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Gateway kan vara värd för **en agent** (standard) eller **många agenter** sida vid sida.

**Arbetsytans anteckning:** varje agents arbetsyta är **standard cwd**, inte en hård
sandlåda. Relativa vägar försvinner inne i arbetsytan, men absoluta vägar kan
nå andra värdplatser om inte sandlådan är aktiverad. Se
[Sandboxing](/gateway/sandboxing).

## Sökvägar (snabbkarta)

- Konfig: `~/.openclaw/openclaw.json` (eller `OPENCLAW_CONFIG_PATH`)
- Tillståndskatalog: `~/.openclaw` (eller `OPENCLAW_STATE_DIR`)
- Arbetsyta: `~/.openclaw/workspace` (eller `~/.openclaw/workspace-<agentId>`)
- Agentkatalog: `~/.openclaw/agents/<agentId>/agent` (eller `agents.list[].agentDir`)
- Sessioner: `~/.openclaw/agents/<agentId>/sessions`

### Enagentsläge (standard)

Om du inte gör något kör OpenClaw en enda agent:

- `agentId` är som standard **`main`**.
- Sessioner nycklas som `agent:main:<mainKey>`.
- Arbetsyta är som standard `~/.openclaw/workspace` (eller `~/.openclaw/workspace-<profile>` när `OPENCLAW_PROFILE` är satt).
- Tillstånd är som standard `~/.openclaw/agents/main/agent`.

## Agenthjälpare

Använd agentguiden för att lägga till en ny isolerad agent:

```bash
openclaw agents add work
```

Lägg sedan till `bindings` (eller låt guiden göra det) för att routa inkommande meddelanden.

Verifiera med:

```bash
openclaw agents list --bindings
```

## Flera agenter = flera personer, flera personligheter

Med **flera agenter** blir varje `agentId` en **helt isolerad persona**:

- **Olika telefonnummer/konton** (per kanal-`accountId`).
- **Olika personligheter** (per-agent-arbetsytefiler som `AGENTS.md` och `SOUL.md`).
- **Separat autentisering + sessioner** (ingen korskommunikation om den inte uttryckligen aktiveras).

Detta gör att **flera personer** kan dela en Gateway-server samtidigt som deras AI-”hjärnor” och data hålls isolerade.

## Ett WhatsApp-nummer, flera personer (DM-delning)

Du kan dirigera **olika WhatsApp DMs** till olika agenter medan du stannar på **ett WhatsApp konto**. Matcha på avsändare E.164 (som `+15551234567`) med `peer.kind: "dm"`. Svaren kommer fortfarande från samma WhatsApp nummer (ingen per-agent avsändare identitet).

Viktig detalj: direktchattar kollapsar till agentens **huvudsessionnyckel**, så verklig isolering kräver **en agent per person**.

Exempel:

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

Noteringar:

- DM-åtkomstkontroll är **global per WhatsApp-konto** (parkoppling/tillåtelselista), inte per agent.
- För delade grupper, bind gruppen till en agent eller använd [Broadcast groups](/channels/broadcast-groups).

## Routningsregler (hur meddelanden väljer agent)

Bindningar är **deterministiska** och **mest specifika vinner**:

1. `peer`-matchning (exakt DM-/grupp-/kanal-id)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. `accountId`-matchning för en kanal
5. matchning på kanalnivå (`accountId: "*"`)
6. fallback till standardagent (`agents.list[].default`, annars första listelementet, standard: `main`)

## Flera konton / telefonnummer

Kanaler som stöder **flera konton** (t.ex. WhatsApp) använder `accountId` för att identifiera
varje inloggning. Varje `accountId` kan dirigeras till en annan agent, så en server kan värd
flera telefonnummer utan att blanda sessioner.

## Begrepp

- `agentId`: en ”hjärna” (arbetsyta, per-agent-autentisering, per-agent-sessionslager).
- `accountId`: en kanal konto instans (t.ex. WhatsApp konto `"personlig"` vs `"biz"`).
- `binding`: routar inkommande meddelanden till en `agentId` via `(channel, accountId, peer)` och valfritt guild-/team-id.
- Direktchattar kollapsar till `agent:<agentId>:<mainKey>` (per-agent ”main”; `session.mainKey`).

## Exempel: två WhatsApp → två agenter

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

## Exempel: WhatsApp vardagschatt + Telegram djupjobb

Dela upp per kanal: routa WhatsApp till en snabb vardagsagent och Telegram till en Opus-agent.

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

Noteringar:

- Om du har flera konton för en kanal, lägg till `accountId` i bindningen (till exempel `{ channel: "whatsapp", accountId: "personal" }`).
- För att routa en enskild DM/grupp till Opus samtidigt som resten behålls på chatt, lägg till en `match.peer`-bindning för den peer:n; peer-matchningar vinner alltid över kanalomfattande regler.

## Exempel: samma kanal, en peer till Opus

Behåll WhatsApp på den snabba agenten, men routa en DM till Opus:

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

Peer-bindningar vinner alltid, så håll dem ovanför den kanalomfattande regeln.

## Familjeagent bunden till en WhatsApp-grupp

Bind en dedikerad familjeagent till en enda WhatsApp-grupp, med omnämnandespärr
och en stramare verktygspolicy:

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

Noteringar:

- Verktyg tillåtna/neka listor är **verktyg**, inte färdigheter. Om en färdighet behöver köra en
  binär, se till att `exec` är tillåten och binären finns i sandlådan.
- För striktare spärrar, sätt `agents.list[].groupChat.mentionPatterns` och behåll
  grupptillåtelselistor aktiverade för kanalen.

## Per-agent Sandbox och verktygskonfiguration

Från och med v2026.1.6 kan varje agent ha sin egen sandbox och verktygsbegränsningar:

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

Obs: `setupCommand` bor under `sandbox.docker` och körs en gång på behållaren skapas.
Per-agent `sandbox.docker.*` åsidosättningar ignoreras när det lösta området är `"delad"`.

**Fördelar:**

- **Säkerhetsisolering**: Begränsa verktyg för opålitliga agenter
- **Resurskontroll**: Sandboxa specifika agenter medan andra körs på värden
- **Flexibla policyer**: Olika behörigheter per agent

Obs: `tools.elevated` är **global** och avsändarbaserad; den är inte konfigurerbar per agent.
Om du behöver gränser per agent, använd `agents.list[].tools` för att neka `exec`.
För gruppinriktning, använd `agents.list[].groupChat.mentionPatterns` så @nämner karta rent till den avsedda agenten.

Se [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) för detaljerade exempel.
