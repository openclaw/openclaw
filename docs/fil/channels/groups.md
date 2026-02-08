---
summary: "Pag-uugali ng group chat sa iba’t ibang surface (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Kapag binabago ang pag-uugali ng group chat o mention gating
title: "Mga Grupo"
x-i18n:
  source_path: channels/groups.md
  source_hash: 5380e07ea01f4a8f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:41Z
---

# Mga Grupo

Tinatrato ng OpenClaw ang mga group chat nang pare-pareho sa iba’t ibang surface: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Panimulang gabay para sa baguhan (2 minuto)

“Naninirahan” ang OpenClaw sa sarili mong mga messaging account. Walang hiwalay na WhatsApp bot user.
Kung **ikaw** ay nasa isang grupo, nakikita ng OpenClaw ang grupong iyon at puwede itong sumagot doon.

Default na pag-uugali:

- Ang mga grupo ay may restriksyon (`groupPolicy: "allowlist"`).
- Nangangailangan ng mention ang mga sagot maliban kung tahasang i-disable mo ang mention gating.

Salin: ang mga allowlisted sender ay puwedeng mag-trigger ng OpenClaw sa pamamagitan ng pag-mention dito.

> TL;DR
>
> - Ang **DM access** ay kinokontrol ng `*.allowFrom`.
> - Ang **Group access** ay kinokontrol ng `*.groupPolicy` + mga allowlist (`*.groups`, `*.groupAllowFrom`).
> - Ang **Reply triggering** ay kinokontrol ng mention gating (`requireMention`, `/activation`).

Mabilis na daloy (ano ang nangyayari sa isang mensahe sa grupo):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Daloy ng mensahe sa grupo](/images/groups-flow.svg)

Kung gusto mo...

| Layunin                                                   | Itatakda                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| Payagan ang lahat ng grupo pero sumagot lang sa @mentions | `groups: { "*": { requireMention: true } }`                |
| I-disable ang lahat ng sagot sa grupo                     | `groupPolicy: "disabled"`                                  |
| Mga partikular na grupo lang                              | `groups: { "<group-id>": { ... } }` (walang `"*"` key)     |
| Ikaw lang ang puwedeng mag-trigger sa mga grupo           | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## Mga session key

- Gumagamit ang mga group session ng `agent:<agentId>:<channel>:group:<id>` na mga session key (ang mga room/channel ay gumagamit ng `agent:<agentId>:<channel>:channel:<id>`).
- Ang Telegram forum topics ay nagdaragdag ng `:topic:<threadId>` sa group id kaya bawat topic ay may sariling session.
- Ang mga direct chat ay gumagamit ng pangunahing session (o per-sender kung naka-configure).
- Nilalaktawan ang heartbeats para sa mga group session.

## Pattern: personal na DM + pampublikong grupo (isang agent)

Oo — maayos itong gumagana kung ang “personal” mong traffic ay **DM** at ang “public” mong traffic ay **mga grupo**.

Bakit: sa single-agent mode, karaniwang napupunta ang mga DM sa **main** session key (`agent:main:main`), habang ang mga grupo ay laging gumagamit ng **non-main** na mga session key (`agent:main:<channel>:group:<id>`). Kung i-enable mo ang sandboxing gamit ang `mode: "non-main"`, tatakbo ang mga group session sa Docker habang nananatiling on-host ang pangunahing DM session mo.

Nagbibigay ito sa iyo ng isang agent na “utak” (shared workspace + memory), pero dalawang posture ng execution:

- **DM**: buong tools (host)
- **Mga grupo**: sandbox + limitadong tools (Docker)

> Kung kailangan mo ng tunay na magkahiwalay na workspace/persona (“personal” at “public” ay hindi dapat maghalo), gumamit ng pangalawang agent + bindings. Tingnan ang [Multi-Agent Routing](/concepts/multi-agent).

Halimbawa (DM sa host, mga grupo ay sandboxed + messaging-only na tools):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Gusto mo ba ng “nakikita lang ng mga grupo ang folder X” sa halip na “walang host access”? Panatilihin ang `workspaceAccess: "none"` at i-mount lang ang mga allowlisted na path papasok sa sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Kaugnay:

- Mga configuration key at default: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- Pag-debug kung bakit naka-block ang isang tool: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Mga detalye ng bind mount: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Mga display label

- Gumagamit ang UI labels ng `displayName` kapag available, na naka-format bilang `<channel>:<token>`.
- Ang `#room` ay nakalaan para sa mga room/channel; ang mga group chat ay gumagamit ng `g-<slug>` (lowercase, mga espasyo -> `-`, panatilihin ang `#@+._-`).

## Group policy

Kontrolin kung paano hinahawakan ang mga mensahe sa grupo/room kada channel:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Policy        | Pag-uugali                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| `"open"`      | Nilalampasan ng mga grupo ang mga allowlist; nananatili ang mention-gating.  |
| `"disabled"`  | I-block ang lahat ng mensahe sa grupo nang buo.                              |
| `"allowlist"` | Payagan lang ang mga grupo/room na tumutugma sa naka-configure na allowlist. |

Mga tala:

- Ang `groupPolicy` ay hiwalay sa mention-gating (na nangangailangan ng @mentions).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: gamitin ang `groupAllowFrom` (fallback: tahasang `allowFrom`).
- Discord: gumagamit ang allowlist ng `channels.discord.guilds.<id>.channels`.
- Slack: gumagamit ang allowlist ng `channels.slack.channels`.
- Matrix: gumagamit ang allowlist ng `channels.matrix.groups` (mga room ID, alias, o pangalan). Gamitin ang `channels.matrix.groupAllowFrom` para limitahan ang mga sender; sinusuportahan din ang per-room `users` na mga allowlist.
- Ang mga Group DM ay hiwalay na kinokontrol (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Ang Telegram allowlist ay puwedeng tumugma sa mga user ID (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) o username (`"@alice"` o `"alice"`); case-insensitive ang mga prefix.
- Default ay `groupPolicy: "allowlist"`; kung walang laman ang group allowlist mo, naka-block ang mga mensahe sa grupo.

Mabilis na mental model (sunod-sunod na evaluation para sa mga mensahe sa grupo):

1. `groupPolicy` (open/disabled/allowlist)
2. mga group allowlist (`*.groups`, `*.groupAllowFrom`, channel-specific allowlist)
3. mention gating (`requireMention`, `/activation`)

## Mention gating (default)

Nangangailangan ng mention ang mga mensahe sa grupo maliban kung na-override kada grupo. Ang mga default ay nakatira kada subsystem sa ilalim ng `*.groups."*"`.

Ang pag-reply sa mensahe ng bot ay binibilang bilang implicit na mention (kapag sinusuportahan ng channel ang reply metadata). Nalalapat ito sa Telegram, WhatsApp, Slack, Discord, at Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Mga tala:

- Ang `mentionPatterns` ay mga case-insensitive regex.
- Ang mga surface na nagbibigay ng explicit mentions ay tuloy pa rin; fallback lang ang mga pattern.
- Per-agent override: `agents.list[].groupChat.mentionPatterns` (kapaki-pakinabang kapag maraming agent ang nagbabahagi ng isang grupo).
- Ipinapatupad lang ang mention gating kapag posible ang mention detection (native mentions o naka-configure ang `mentionPatterns`).
- Ang mga default ng Discord ay nasa `channels.discord.guilds."*"` (maaaring i-override kada guild/channel).
- Ang context ng history ng grupo ay binalot nang pare-pareho sa lahat ng channel at **pending-only** (mga mensaheng nilaktawan dahil sa mention gating); gamitin ang `messages.groupChat.historyLimit` para sa global default at ang `channels.<channel>.historyLimit` (o `channels.<channel>.accounts.*.historyLimit`) para sa mga override. Itakda ang `0` para i-disable.

## Mga restriksiyon sa tool ng grupo/channel (opsyonal)

May ilang channel config na sumusuporta sa paglilimita kung aling mga tool ang available **sa loob ng isang partikular na grupo/room/channel**.

- `tools`: payagan/itanggi ang mga tool para sa buong grupo.
- `toolsBySender`: per-sender na mga override sa loob ng grupo (ang mga key ay sender ID/username/email/numero ng telepono depende sa channel). Gamitin ang `"*"` bilang wildcard.

Ayos ng resolusyon (pinaka-espesipiko ang nananalo):

1. tugma ng group/channel `toolsBySender`
2. group/channel `tools`
3. default (`"*"`) tugma ng `toolsBySender`
4. default (`"*"`) `tools`

Halimbawa (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Mga tala:

- Ang mga restriksiyon sa tool ng grupo/channel ay inilalapat bukod pa sa global/agent tool policy (ang deny ay nananalo pa rin).
- Gumagamit ang ilang channel ng ibang nesting para sa mga room/channel (hal., Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Mga group allowlist

Kapag naka-configure ang `channels.whatsapp.groups`, `channels.telegram.groups`, o `channels.imessage.groups`, kumikilos ang mga key bilang group allowlist. Gamitin ang `"*"` para payagan ang lahat ng grupo habang itinatakda pa rin ang default na pag-uugali ng mention.

Mga karaniwang intensyon (copy/paste):

1. I-disable ang lahat ng sagot sa grupo

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Payagan lang ang mga partikular na grupo (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Payagan ang lahat ng grupo pero kailangan ng mention (tahasang)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Ang owner lang ang puwedeng mag-trigger sa mga grupo (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Activation (owner-only)

Puwedeng i-toggle ng mga group owner ang activation kada grupo:

- `/activation mention`
- `/activation always`

Tinutukoy ang owner ng `channels.whatsapp.allowFrom` (o ang sariling E.164 ng bot kapag hindi nakatakda). Ipadala ang command bilang hiwalay na mensahe. Sa kasalukuyan, binabalewala ng ibang surface ang `/activation`.

## Mga context field

Itinatakda ng mga inbound payload ng grupo ang:

- `ChatType=group`
- `GroupSubject` (kung alam)
- `GroupMembers` (kung alam)
- `WasMentioned` (resulta ng mention gating)
- Ang mga Telegram forum topic ay kasama rin ang `MessageThreadId` at `IsForum`.

Kasama sa system prompt ng agent ang isang group intro sa unang turn ng bagong group session. Ipinapaalala nito sa model na sumagot na parang tao, iwasan ang mga Markdown table, at iwasang mag-type ng literal na `\n` na mga sequence.

## Mga detalye para sa iMessage

- Mas piliin ang `chat_id:<id>` kapag nagra-route o nag-a-allowlist.
- Listahan ng mga chat: `imsg chats --limit 20`.
- Ang mga sagot sa grupo ay laging bumabalik sa parehong `chat_id`.

## Mga detalye para sa WhatsApp

Tingnan ang [Group messages](/channels/group-messages) para sa behavior na WhatsApp-only (history injection, mga detalye ng paghawak ng mention).
