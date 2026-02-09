---
summary: "Routningsregler per kanal (WhatsApp, Telegram, Discord, Slack) och delad kontext"
read_when:
  - Ändrar kanalroutning eller inkorgsbeteende
title: "Kanalroutning"
---

# Kanaler & routning

OpenClaw rutter svarar **tillbaka till kanalen där ett meddelande kom från**. Modellen
väljer inte en kanal; routing är deterministisk och kontrolleras av värdens
konfiguration.

## Nyckelbegrepp

- **Kanal**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: per‑kanal konto‑instans (när det stöds).
- **AgentId**: en isolerad arbetsyta + sessionslager (”hjärna”).
- **SessionKey**: hinknyckeln som används för att lagra kontext och styra samtidighet.

## Sessionnycklars former (exempel)

Direktmeddelanden slås ihop till agentens **huvud**‑session:

- `agent:<agentId>:<mainKey>` (standard: `agent:main:main`)

Grupper och kanaler förblir isolerade per kanal:

- Grupper: `agent:<agentId>:<channel>:group:<id>`
- Kanaler/rum: `agent:<agentId>:<channel>:channel:<id>`

Trådar:

- Slack/Discord‑trådar lägger till `:thread:<threadId>` till basnyckeln.
- Telegram‑forumämnen bäddar in `:topic:<topicId>` i gruppnyckeln.

Exempel:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Routningsregler (hur en agent väljs)

Routning väljer **en agent** för varje inkommande meddelande:

1. **Exakt peer‑match** (`bindings` med `peer.kind` + `peer.id`).
2. **Guild‑match** (Discord) via `guildId`.
3. **Team‑match** (Slack) via `teamId`.
4. **Kontomatch** (`accountId` på kanalen).
5. **Kanal‑match** (valfritt konto på den kanalen).
6. **Standardagent** (`agents.list[].default`, annars första listposten, fallback till `main`).

Den matchade agenten avgör vilken arbetsyta och vilket sessionslager som används.

## Broadcast‑grupper (kör flera agenter)

Broadcast‑grupper låter dig köra **flera agenter** för samma peer **när OpenClaw normalt skulle svara** (till exempel: i WhatsApp‑grupper, efter omnämnande/aktiverings‑gating).

Konfig:

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

## Konfigöversikt

- `agents.list`: namngivna agentdefinitioner (arbetsyta, modell, etc.).
- `bindings`: mappa inkommande kanaler/konton/peers till agenter.

Exempel:

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

## Sessionslagring

Sessionslager ligger under tillståndskatalogen (standard `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL‑transkript ligger sida vid sida med lagret

Du kan åsidosätta lagringsvägen via `session.store` och `{agentId}`‑mallning.

## WebChat‑beteende

WebChat bifogar **den valda agenten** och är standard för agentens huvudsakliga
session. På grund av detta, kan WebChat du se cross‐channel sammanhang för den
agent på ett ställe.

## Svarskontext

Inkommande svar inkluderar:

- `ReplyToId`, `ReplyToBody` och `ReplyToSender` när tillgängligt.
- Citerad kontext läggs till i `Body` som ett `[Replying to ...]`‑block.

Detta är konsekvent över kanaler.
