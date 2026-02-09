---
summary: "Ruteringsregler pr. kanal (WhatsApp, Telegram, Discord, Slack) og delt kontekst"
read_when:
  - Ændring af kanalrouting eller indbakkens adfærd
title: "Kanalrouting"
---

# Kanaler & routing

OpenClaw ruter besvarer **tilbage til kanalen, hvor en meddelelse kom fra**.
-modellen vælger ikke en kanal; routing er deterministisk og styres af
-værtens konfiguration.

## Nøglebegreber

- **Kanal**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: pr.-kanal konto-instans (når understøttet).
- **AgentId**: et isoleret workspace + session‑lager (“hjerne”).
- **SessionKey**: bucket-nøglen, der bruges til at gemme kontekst og styre samtidighed.

## Session key-former (eksempler)

Direkte beskeder samles i agentens **hoved**-session:

- `agent:<agentId>:<mainKey>` (standard: `agent:main:main`)

Grupper og kanaler forbliver isoleret pr. kanal:

- Grupper: `agent:<agentId>:<channel>:group:<id>`
- Kanaler/rum: `agent:<agentId>:<channel>:channel:<id>`

Tråde:

- Slack/Discord-tråde tilføjer `:thread:<threadId>` til basisnøglen.
- Telegram-forumemner indlejrer `:topic:<topicId>` i gruppenøglen.

Eksempler:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Ruteringsregler (hvordan en agent vælges)

Routing vælger **én agent** for hver indgående besked:

1. **Præcis peer-match** (`bindings` med `peer.kind` + `peer.id`).
2. **Guild-match** (Discord) via `guildId`.
3. **Team-match** (Slack) via `teamId`.
4. **Account-match** (`accountId` på kanalen).
5. **Kanal-match** (enhver konto på den kanal).
6. **Standardagent** (`agents.list[].default`, ellers første listepost, fallback til `main`).

Den matchede agent afgør, hvilket workspace og hvilket session‑lager der bruges.

## Broadcast-grupper (kør flere agenter)

Broadcast-grupper lader dig køre **flere agenter** for den samme peer **når OpenClaw normalt ville svare** (for eksempel: i WhatsApp-grupper, efter mention/aktiverings-gating).

Konfiguration:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Se: [Broadcast Groups](/channels/broadcast-groups).

## Konfigurationsoversigt

- `agents.list`: navngivne agentdefinitioner (workspace, model m.m.).
- `bindings`: kortlægger indgående kanaler/konti/peers til agenter.

Eksempel:

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

## Session‑lager

Session‑lagre ligger under state‑mappen (standard `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL‑transkripter ligger side om side med lageret

Du kan tilsidesætte lagerstien via `session.store` og `{agentId}` templating.

## WebChat-adfærd

WebChat knytter sig til den \*\* valgte agent \*\* og standard til agentens vigtigste
session. På grund af dette, WebChat giver dig mulighed for at se cross-channel sammenhæng for at
agent på ét sted.

## Svarkontekst

Indgående svar indeholder:

- `ReplyToId`, `ReplyToBody` og `ReplyToSender` når tilgængeligt.
- Citeret kontekst føjes til `Body` som en `[Replying to ...]`‑blok.

Dette er konsistent på tværs af kanaler.
