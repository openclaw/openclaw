---
summary: "Routeringsregels per kanaal (WhatsApp, Telegram, Discord, Slack) en gedeelde context"
read_when:
  - Bij het wijzigen van kanaalroutering of inboxgedrag
title: "Kanaalroutering"
---

# Kanalen & routering

OpenClaw routeert antwoorden **terug naar het kanaal waar een bericht vandaan kwam**. Het
model kiest geen kanaal; routering is deterministisch en wordt beheerd door de
hostconfiguratie.

## Belangrijke termen

- **Kanaal**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: per‑kanaal accountinstantie (indien ondersteund).
- **AgentId**: een geïsoleerde werkruimte + sessieopslag (“brein”).
- **SessionKey**: de bucketsleutel die wordt gebruikt om context op te slaan en gelijktijdigheid te beheren.

## Vormen van sessiesleutels (voorbeelden)

Directe berichten worden samengevoegd tot de **hoofd**sessie van de agent:

- `agent:<agentId>:<mainKey>` (standaard: `agent:main:main`)

Groepen en kanalen blijven per kanaal geïsoleerd:

- Groepen: `agent:<agentId>:<channel>:group:<id>`
- Kanalen/rooms: `agent:<agentId>:<channel>:channel:<id>`

Threads:

- Slack/Discord-threads voegen `:thread:<threadId>` toe aan de basissleutel.
- Telegram-forumtopics embedden `:topic:<topicId>` in de groepssleutel.

Voorbeelden:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Routeringsregels (hoe een agent wordt gekozen)

Routering kiest **één agent** voor elk inkomend bericht:

1. **Exacte peer-match** (`bindings` met `peer.kind` + `peer.id`).
2. **Guild-match** (Discord) via `guildId`.
3. **Team-match** (Slack) via `teamId`.
4. **Account-match** (`accountId` op het kanaal).
5. **Kanaal-match** (elk account op dat kanaal).
6. **Standaardagent** (`agents.list[].default`, anders eerste lijstitem, fallback naar `main`).

De gematchte agent bepaalt welke werkruimte en sessieopslag worden gebruikt.

## Broadcast-groepen (meerdere agents draaien)

Broadcast-groepen laten je **meerdere agents** draaien voor dezelfde peer **wanneer OpenClaw normaal gesproken zou antwoorden** (bijvoorbeeld: in WhatsApp-groepen, na mention-/activeringsgating).

Config:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Zie: [Broadcast Groups](/channels/broadcast-groups).

## Config-overzicht

- `agents.list`: benoemde agentdefinities (werkruimte, model, enz.).
- `bindings`: koppelt inkomende kanalen/accounts/peers aan agents.

Voorbeeld:

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

## Sessiesopslag

Sessiestores bevinden zich onder de state-directory (standaard `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL-transcripten staan naast de store

Je kunt het pad van de store overschrijven via `session.store` en `{agentId}`-templating.

## WebChat-gedrag

WebChat koppelt aan de **geselecteerde agent** en gebruikt standaard de hoofd-
sessie van de agent. Hierdoor kun je met WebChat de context over meerdere kanalen
voor die agent op één plek bekijken.

## Antwoordcontext

Inkomende antwoorden bevatten:

- `ReplyToId`, `ReplyToBody` en `ReplyToSender` wanneer beschikbaar.
- Geciteerde context wordt toegevoegd aan `Body` als een `[Replying to ...]`-blok.

Dit is consistent over alle kanalen.
