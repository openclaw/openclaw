---
summary: "Multi-agent routing: geïsoleerde agents, kanaalaccounts en bindingen"
title: Multi-Agent Routering
read_when: "Je wilt meerdere geïsoleerde agents (werkruimtes + auth) in één Gateway-proces."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:27Z
---

# Multi-Agent Routering

Doel: meerdere _geïsoleerde_ agents (aparte werkruimte + `agentDir` + sessies), plus meerdere kanaalaccounts (bijv. twee WhatsApps) in één draaiende Gateway. Inkomend verkeer wordt via bindingen naar een agent gerouteerd.

## Wat is “één agent”?

Een **agent** is een volledig afgebakend brein met zijn eigen:

- **Werkruimte** (bestanden, AGENTS.md/SOUL.md/USER.md, lokale notities, persona-regels).
- **Statusmap** (`agentDir`) voor auth-profielen, modelregister en per-agent config.
- **Sessiestore** (chatgeschiedenis + routeringsstatus) onder `~/.openclaw/agents/<agentId>/sessions`.

Auth-profielen zijn **per agent**. Elke agent leest uit zijn eigen:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Hoofdagent-credentials worden **niet** automatisch gedeeld. Hergebruik `agentDir`
nooit tussen agents (dit veroorzaakt auth-/sessieconflicten). Als je credentials wilt delen,
kopieer `auth-profiles.json` naar de `agentDir` van de andere agent.

Skills zijn per agent via de map `skills/` van elke werkruimte, met gedeelde skills
beschikbaar vanuit `~/.openclaw/skills`. Zie [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

De Gateway kan **één agent** (standaard) of **meerdere agents** naast elkaar hosten.

**Werkruimte-opmerking:** de werkruimte van elke agent is de **standaard cwd**, geen harde
sandbox. Relatieve paden worden binnen de werkruimte opgelost, maar absolute paden kunnen
andere hostlocaties bereiken tenzij sandboxing is ingeschakeld. Zie
[Sandboxing](/gateway/sandboxing).

## Paden (snelle kaart)

- Config: `~/.openclaw/openclaw.json` (of `OPENCLAW_CONFIG_PATH`)
- Statusmap: `~/.openclaw` (of `OPENCLAW_STATE_DIR`)
- Werkruimte: `~/.openclaw/workspace` (of `~/.openclaw/workspace-<agentId>`)
- Agentmap: `~/.openclaw/agents/<agentId>/agent` (of `agents.list[].agentDir`)
- Sessies: `~/.openclaw/agents/<agentId>/sessions`

### Single-agentmodus (standaard)

Als je niets doet, draait OpenClaw met één agent:

- `agentId` staat standaard op **`main`**.
- Sessies zijn gesleuteld als `agent:main:<mainKey>`.
- Werkruimte staat standaard op `~/.openclaw/workspace` (of `~/.openclaw/workspace-<profile>` wanneer `OPENCLAW_PROFILE` is ingesteld).
- Status staat standaard op `~/.openclaw/agents/main/agent`.

## Agent-helper

Gebruik de agent-wizard om een nieuwe geïsoleerde agent toe te voegen:

```bash
openclaw agents add work
```

Voeg vervolgens `bindings` toe (of laat de wizard dit doen) om inkomende berichten te routeren.

Verifieer met:

```bash
openclaw agents list --bindings
```

## Meerdere agents = meerdere mensen, meerdere persoonlijkheden

Met **meerdere agents** wordt elke `agentId` een **volledig geïsoleerde persona**:

- **Verschillende telefoonnummers/accounts** (per kanaal `accountId`).
- **Verschillende persoonlijkheden** (per-agent werkruimtebestanden zoals `AGENTS.md` en `SOUL.md`).
- **Gescheiden auth + sessies** (geen kruisverkeer tenzij expliciet ingeschakeld).

Dit laat **meerdere mensen** één Gateway-server delen terwijl hun AI-“breinen” en data geïsoleerd blijven.

## Eén WhatsApp-nummer, meerdere mensen (DM-splitsing)

Je kunt **verschillende WhatsApp-DM’s** naar verschillende agents routeren terwijl je op **één WhatsApp-account** blijft. Match op afzender E.164 (zoals `+15551234567`) met `peer.kind: "dm"`. Antwoorden komen nog steeds van hetzelfde WhatsApp-nummer (geen per-agent afzenderidentiteit).

Belangrijk detail: directe chats vallen samen tot de **hoofdsessiesleutel** van de agent, dus echte isolatie vereist **één agent per persoon**.

Voorbeeld:

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

Notities:

- DM-toegangsbeheer is **globaal per WhatsApp-account** (koppeling/toegestane lijst), niet per agent.
- Voor gedeelde groepen: bind de groep aan één agent of gebruik [Broadcast groups](/channels/broadcast-groups).

## Routeringsregels (hoe berichten een agent kiezen)

Bindingen zijn **deterministisch** en **meest-specifiek wint**:

1. `peer`-match (exacte DM/groep/kanaal-id)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. `accountId`-match voor een kanaal
5. match op kanaalniveau (`accountId: "*"`)
6. terugval naar standaardagent (`agents.list[].default`, anders eerste lijstvermelding, standaard: `main`)

## Meerdere accounts / telefoonnummers

Kanalen die **meerdere accounts** ondersteunen (bijv. WhatsApp) gebruiken `accountId` om
elke login te identificeren. Elke `accountId` kan naar een andere agent worden gerouteerd,
zodat één server meerdere telefoonnummers kan hosten zonder sessies te mengen.

## Concepten

- `agentId`: één “brein” (werkruimte, per-agent auth, per-agent sessiestore).
- `accountId`: één kanaalaccount-instantie (bijv. WhatsApp-account `"personal"` vs `"biz"`).
- `binding`: routeert inkomende berichten naar een `agentId` op basis van `(channel, accountId, peer)` en optioneel guild-/team-id’s.
- Directe chats vallen samen tot `agent:<agentId>:<mainKey>` (per-agent “main”; `session.mainKey`).

## Voorbeeld: twee WhatsApps → twee agents

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

## Voorbeeld: WhatsApp dagelijkse chat + Telegram diep werk

Splits op kanaal: routeer WhatsApp naar een snelle alledaagse agent en Telegram naar een Opus-agent.

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

Notities:

- Als je meerdere accounts voor een kanaal hebt, voeg `accountId` toe aan de binding (bijvoorbeeld `{ channel: "whatsapp", accountId: "personal" }`).
- Om één DM/groep naar Opus te routeren terwijl de rest op chat blijft, voeg een `match.peer`-binding toe voor die peer; peer-matches winnen altijd van kanaalbrede regels.

## Voorbeeld: hetzelfde kanaal, één peer naar Opus

Houd WhatsApp op de snelle agent, maar routeer één DM naar Opus:

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

Peer-bindingen winnen altijd, dus houd ze boven de kanaalbrede regel.

## Familie-agent gebonden aan een WhatsApp-groep

Bind een speciale familie-agent aan één WhatsApp-groep, met mention-gating
en een strakker toolbeleid:

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

Notities:

- Tool-toegestane/weigerlijsten zijn **tools**, geen skills. Als een skill een
  binary moet uitvoeren, zorg ervoor dat `exec` is toegestaan en dat de binary in de sandbox bestaat.
- Voor strengere gating, stel `agents.list[].groupChat.mentionPatterns` in en houd
  groep-toegestane lijsten ingeschakeld voor het kanaal.

## Per-agent Sandbox- en Toolconfiguratie

Vanaf v2026.1.6 kan elke agent zijn eigen sandbox en toolbeperkingen hebben:

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

Let op: `setupCommand` staat onder `sandbox.docker` en wordt één keer uitgevoerd bij het aanmaken van de container.
Per-agent `sandbox.docker.*`-overschrijvingen worden genegeerd wanneer het opgeloste bereik `"shared"` is.

**Voordelen:**

- **Beveiligingsisolatie**: Beperk tools voor onbetrouwbare agents
- **Resourcebeheer**: Sandbox specifieke agents terwijl anderen op de host blijven
- **Flexibele beleidsregels**: Verschillende rechten per agent

Let op: `tools.elevated` is **globaal** en afzendergebaseerd; het is niet per agent configureerbaar.
Als je per-agent grenzen nodig hebt, gebruik `agents.list[].tools` om `exec` te weigeren.
Voor groepsdoelgroepering gebruik je `agents.list[].groupChat.mentionPatterns` zodat @mentions netjes naar de bedoelde agent mappen.

Zie [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) voor gedetailleerde voorbeelden.
