---
summary: "Mga patakaran sa routing bawat channel (WhatsApp, Telegram, Discord, Slack) at shared na context"
read_when:
  - Pagbabago ng channel routing o behavior ng inbox
title: "Channel Routing"
x-i18n:
  source_path: channels/channel-routing.md
  source_hash: cfc2cade2984225d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:21Z
---

# Mga channel at routing

Niri-route ng OpenClaw ang mga reply **pabalik sa channel kung saan nanggaling ang mensahe**. Hindi pumipili ng channel ang model; deterministic ang routing at kinokontrol ng host configuration.

## Mga pangunahing termino

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: per‑channel na instance ng account (kapag supported).
- **AgentId**: isang isolated na workspace + session store (“utak”).
- **SessionKey**: ang bucket key na ginagamit para mag-store ng context at magkontrol ng concurrency.

## Mga hugis ng session key (mga halimbawa)

Ang mga direct message ay nagsasama-sama sa **main** session ng agent:

- `agent:<agentId>:<mainKey>` (default: `agent:main:main`)

Ang mga group at channel ay nananatiling isolated bawat channel:

- Mga grupo: `agent:<agentId>:<channel>:group:<id>`
- Mga channel/room: `agent:<agentId>:<channel>:channel:<id>`

Mga thread:

- Ang mga Slack/Discord thread ay nagdadagdag ng `:thread:<threadId>` sa base key.
- Ang mga Telegram forum topic ay ine-embed ang `:topic:<topicId>` sa group key.

Mga halimbawa:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Mga patakaran sa routing (kung paano napipili ang agent)

Pinipili ng routing ang **isang agent** para sa bawat inbound na mensahe:

1. **Eksaktong peer match** (`bindings` na may `peer.kind` + `peer.id`).
2. **Guild match** (Discord) sa pamamagitan ng `guildId`.
3. **Team match** (Slack) sa pamamagitan ng `teamId`.
4. **Account match** (`accountId` sa channel).
5. **Channel match** (anumang account sa channel na iyon).
6. **Default agent** (`agents.list[].default`, kung hindi ay unang entry sa listahan, fallback sa `main`).

Tinutukoy ng matched agent kung aling workspace at session store ang gagamitin.

## Mga broadcast group (patakbuhin ang maraming agent)

Pinapayagan ka ng mga broadcast group na magpatakbo ng **maraming agent** para sa parehong peer **kapag normal na magre-reply ang OpenClaw** (halimbawa: sa mga WhatsApp group, pagkatapos ng mention/activation gating).

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

Tingnan: [Broadcast Groups](/channels/broadcast-groups).

## Pangkalahatang-ideya ng config

- `agents.list`: mga pinangalanang definition ng agent (workspace, model, atbp.).
- `bindings`: pagma-map ng inbound channels/accounts/peers papunta sa mga agent.

Halimbawa:

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

## Session storage

Ang mga session store ay nasa ilalim ng state directory (default `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Ang mga JSONL transcript ay naka-store katabi ng store

Maaari mong i-override ang store path sa pamamagitan ng `session.store` at `{agentId}` templating.

## Behavior ng WebChat

Ang WebChat ay kumakabit sa **napiling agent** at default sa main session ng agent. Dahil dito, pinapahintulutan ng WebChat na makita mo ang cross‑channel context para sa agent na iyon sa iisang lugar.

## Context ng reply

Kasama sa mga inbound reply ang:

- `ReplyToId`, `ReplyToBody`, at `ReplyToSender` kapag available.
- Ang quoted context ay idinadagdag sa `Body` bilang isang `[Replying to ...]` block.

Pare-pareho ito sa lahat ng channel.
