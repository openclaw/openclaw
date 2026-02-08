---
summary: "မျက်နှာပြင်များအနှံ့ (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams) တွင် အုပ်စုချတ် အပြုအမူ"
read_when:
  - အုပ်စုချတ် အပြုအမူ သို့မဟုတ် mention gating ကို ပြောင်းလဲသည့်အခါ
title: "အုပ်စုများ"
x-i18n:
  source_path: channels/groups.md
  source_hash: 5380e07ea01f4a8f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:31Z
---

# အုပ်စုများ

OpenClaw သည် မျက်နှာပြင်များအနှံ့ရှိ အုပ်စုချတ်များကို တစ်သမတ်တည်း ကိုင်တွယ်ဆောင်ရွက်သည် — WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams။

## စတင်သူအတွက် အကျဉ်းချုပ် (၂ မိနစ်)

OpenClaw သည် သင့်ကိုယ်ပိုင် မက်ဆေ့ချ်အကောင့်များပေါ်တွင်ပင် “နေထိုင်” လုပ်ဆောင်ပါသည်။ သီးခြား WhatsApp bot အသုံးပြုသူ မရှိပါ။
**သင်** အုပ်စုတစ်ခုအတွင်းရှိနေပါက OpenClaw သည် အဲဒီအုပ်စုကို မြင်နိုင်ပြီး အဲဒီနေရာမှာပင် ပြန်ကြားနိုင်ပါသည်။

မူလအပြုအမူ (Default behavior) —

- အုပ်စုများကို ကန့်သတ်ထားပါသည် (`groupPolicy: "allowlist"`)။
- သင်က mention gating ကို တိတိကျကျ မပိတ်ထားသရွေ့ ပြန်ကြားမှုများအတွက် mention လိုအပ်ပါသည်။

ဘာသာပြန်ဆိုလိုသည်မှာ — ခွင့်ပြုစာရင်းထဲရှိ ပို့သူများက OpenClaw ကို mention လုပ်ခြင်းဖြင့်သာ လှုံ့ဆော်နိုင်သည်။

> TL;DR
>
> - **DM ဝင်ရောက်ခွင့်** ကို `*.allowFrom` ဖြင့် ထိန်းချုပ်ပါသည်။
> - **အုပ်စု ဝင်ရောက်ခွင့်** ကို `*.groupPolicy` + ခွင့်ပြုစာရင်းများ (`*.groups`, `*.groupAllowFrom`) ဖြင့် ထိန်းချုပ်ပါသည်။
> - **ပြန်ကြားမှု လှုံ့ဆော်ခြင်း** ကို mention gating (`requireMention`, `/activation`) ဖြင့် ထိန်းချုပ်ပါသည်။

အမြန်လမ်းကြောင်း (အုပ်စုမက်ဆေ့ချ်တစ်ခုတွင် ဖြစ်ပျက်ပုံ) —

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

သင် လိုချင်ပါက —

| ရည်ရွယ်ချက်                                                        | ချိန်ညှိရမည့်အရာ                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| အုပ်စုအားလုံးကို ခွင့်ပြုပေမယ့် @mention လုပ်မှသာ ပြန်ကြားစေလိုပါက | `groups: { "*": { requireMention: true } }`                |
| အုပ်စုအားလုံးတွင် ပြန်ကြားမှု ပိတ်လိုပါက                           | `groupPolicy: "disabled"`                                  |
| အုပ်စု သတ်မှတ်ချက်အချို့သာ ခွင့်ပြုလိုပါက                          | `groups: { "<group-id>": { ... } }` (`"*"` ကီး မလို)       |
| အုပ်စုတွင် သင်သာ လှုံ့ဆော်နိုင်စေရန်                               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## ဆက်ရှင် ကီးများ

- အုပ်စု ဆက်ရှင်များသည် `agent:<agentId>:<channel>:group:<id>` ဆက်ရှင် ကီးများကို အသုံးပြုသည် (rooms/ချန်နယ်များမှာ `agent:<agentId>:<channel>:channel:<id>` ကို အသုံးပြုသည်)။
- Telegram forum topics များတွင် အုပ်စု ID သို့ `:topic:<threadId>` ကို ထပ်ပေါင်းထားပြီး topic တစ်ခုစီအတွက် ကိုယ်ပိုင် ဆက်ရှင် ရရှိစေသည်။
- တိုက်ရိုက် ချတ်များ (Direct chats) သည် အဓိက ဆက်ရှင်ကို အသုံးပြုသည် (သို့မဟုတ် စီစဉ်ထားပါက ပို့သူတစ်ဦးချင်းစီအလိုက်)။
- Heartbeats များကို အုပ်စု ဆက်ရှင်များတွင် ကျော်လွှားထားပါသည်။

## ပုံစံ: ကိုယ်ရေးကိုယ်တာ DMs + အများပြည်သူ အုပ်စုများ (အေးဂျင့်တစ်ခုတည်း)

ဟုတ်ပါတယ် — သင့် “ကိုယ်ရေးကိုယ်တာ” လှုပ်ရှားမှုများသည် **DMs** ဖြစ်ပြီး “အများပြည်သူ” လှုပ်ရှားမှုများသည် **အုပ်စုများ** ဖြစ်ပါက ဤပုံစံသည် ကောင်းစွာ အလုပ်လုပ်ပါသည်။

အကြောင်းရင်းမှာ — single-agent mode တွင် DMs များသည် အများအားဖြင့် **အဓိက** ဆက်ရှင် ကီး (`agent:main:main`) သို့ ရောက်ရှိပြီး အုပ်စုများသည် အမြဲတမ်း **non-main** ဆက်ရှင် ကီးများ (`agent:main:<channel>:group:<id>`) ကို အသုံးပြုပါသည်။ သင် `mode: "non-main"` ဖြင့် sandboxing ကို ဖွင့်ထားပါက အုပ်စု ဆက်ရှင်များသည် Docker အတွင်းတွင် လည်ပတ်မည်ဖြစ်ပြီး သင့်အဓိက DM ဆက်ရှင်မှာ ဟို့စ်ပေါ်တွင် ဆက်လက် ရှိနေပါမည်။

ဤအရာကြောင့် အေးဂျင့် “ဦးနှောက်” တစ်ခု (မျှဝေထားသော workspace + မှတ်ဉာဏ်) ကို အသုံးပြုနိုင်ပြီး လုပ်ဆောင်မှု အနေအထား နှစ်မျိုး ရရှိပါသည် —

- **DMs**: ကိရိယာ အပြည့်အစုံ (ဟို့စ်)
- **အုပ်စုများ**: sandbox + ကန့်သတ်ထားသော ကိရိယာများ (Docker)

> အကယ်၍ အလုပ်ခန်း/ပုဂ္ဂိုလ်ရေး အခန်းကဏ္ဍများကို တကယ့်ကို ခွဲခြားထားရမည်ဆိုပါက (“ကိုယ်ရေးကိုယ်တာ” နှင့် “အများပြည်သူ” ကို မည်သည့်အခါမှ မရောနှောရ) အေးဂျင့် ဒုတိယတစ်ခု + bindings ကို အသုံးပြုပါ။ [Multi-Agent Routing](/concepts/multi-agent) ကို ကြည့်ပါ။

ဥပမာ (DMs ကို ဟို့စ်ပေါ်တွင်၊ အုပ်စုများကို sandboxed + messaging-only ကိရိယာများ) —

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

“ဟို့စ်ကို မဝင်ရောက်စေ” အစား “အုပ်စုများသည် folder X ကိုသာ မြင်နိုင်စေ” လိုပါက `workspaceAccess: "none"` ကို ထိန်းထားပြီး ခွင့်ပြုထားသော လမ်းကြောင်းများကိုသာ sandbox ထဲသို့ mount လုပ်ပါ —

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

ဆက်စပ် —

- ဖွဲ့စည်းပြင်ဆင်မှု ကီးများနှင့် မူလတန်ဖိုးများ: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- ကိရိယာတစ်ခု ဘာကြောင့် ပိတ်ထားသလဲ စစ်ဆေးခြင်း: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Bind mounts အသေးစိတ်: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## ပြသ အညွှန်းများ

- UI အညွှန်းများသည် ရရှိနိုင်ပါက `displayName` ကို အသုံးပြုပြီး `<channel>:<token>` ပုံစံဖြင့် ဖော်ပြပါသည်။
- `#room` ကို rooms/ချန်နယ်များအတွက်သာ သတ်မှတ်ထားပြီး အုပ်စုချတ်များတွင် `g-<slug>` ကို အသုံးပြုပါသည် (အောက်ကေ့စ်၊ space များကို `-` သို့ ပြောင်းပြီး `#@+._-` ကို ထိန်းထားပါ)။

## အုပ်စု မူဝါဒ

ချန်နယ်အလိုက် အုပ်စု/room မက်ဆေ့ချ်များကို မည်သို့ ကိုင်တွယ်မည်ကို ထိန်းချုပ်ပါ —

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

| မူဝါဒ         | အပြုအမူ                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `"open"`      | အုပ်စုများသည် ခွင့်ပြုစာရင်းများကို ကျော်လွှားနိုင်ပြီး mention-gating သည် ဆက်လက် သက်ရောက်ပါသည်။ |
| `"disabled"`  | အုပ်စု မက်ဆေ့ချ်အားလုံးကို လုံးဝ ပိတ်ထားပါသည်။                                                   |
| `"allowlist"` | စီစဉ်ထားသော ခွင့်ပြုစာရင်းနှင့် ကိုက်ညီသည့် အုပ်စု/room များကိုသာ ခွင့်ပြုပါသည်။                 |

မှတ်ချက်များ —

- `groupPolicy` သည် mention-gating ( @mention လိုအပ်မှု ) နှင့် သီးခြားဖြစ်ပါသည်။
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` ကို အသုံးပြုပါ (fallback: ထင်ရှားစွာ သတ်မှတ်ထားသော `allowFrom`)။
- Discord: ခွင့်ပြုစာရင်းတွင် `channels.discord.guilds.<id>.channels` ကို အသုံးပြုပါသည်။
- Slack: ခွင့်ပြုစာရင်းတွင် `channels.slack.channels` ကို အသုံးပြုပါသည်။
- Matrix: ခွင့်ပြုစာရင်းတွင် `channels.matrix.groups` (room IDs, aliases, သို့မဟုတ် အမည်များ) ကို အသုံးပြုပါသည်။ ပို့သူများကို ကန့်သတ်ရန် `channels.matrix.groupAllowFrom` ကို အသုံးပြုနိုင်ပြီး room အလိုက် `users` ခွင့်ပြုစာရင်းများကိုလည်း ပံ့ပိုးပါသည်။
- Group DMs များကို သီးခြား ထိန်းချုပ်ပါသည် (`channels.discord.dm.*`, `channels.slack.dm.*`)။
- Telegram ခွင့်ပြုစာရင်းသည် user IDs (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) သို့မဟုတ် usernames (`"@alice"` သို့မဟုတ် `"alice"`) နှင့် ကိုက်ညီနိုင်ပြီး prefix များသည် case-insensitive ဖြစ်ပါသည်။
- မူလတန်ဖိုးမှာ `groupPolicy: "allowlist"` ဖြစ်ပြီး သင့်အုပ်စု ခွင့်ပြုစာရင်းသည် အလွတ်ဖြစ်ပါက အုပ်စု မက်ဆေ့ချ်များကို ပိတ်ထားပါသည်။

အမြန် စိတ်ကူးပုံစံ (အုပ်စု မက်ဆေ့ချ်များအတွက် စစ်ဆေး အစဉ်) —

1. `groupPolicy` (open/disabled/allowlist)
2. အုပ်စု ခွင့်ပြုစာရင်းများ (`*.groups`, `*.groupAllowFrom`, ချန်နယ်အလိုက် ခွင့်ပြုစာရင်း)
3. mention gating (`requireMention`, `/activation`)

## Mention gating (မူလ)

အုပ်စု မက်ဆေ့ချ်များသည် အုပ်စုအလိုက် override မလုပ်ထားပါက mention လိုအပ်ပါသည်။ မူလတန်ဖိုးများကို `*.groups."*"` အောက်ရှိ subsystem အလိုက် ထားရှိပါသည်။

bot မက်ဆေ့ချ်တစ်ခုကို reply ပြန်လုပ်ခြင်းသည် implicit mention အဖြစ် တွက်ချက်ပါသည် (ချန်နယ်က reply metadata ကို ပံ့ပိုးပါက)။ ဤအရာသည် Telegram, WhatsApp, Slack, Discord, Microsoft Teams တွင် သက်ရောက်ပါသည်။

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

မှတ်ချက်များ —

- `mentionPatterns` များသည် case-insensitive regex များဖြစ်ပါသည်။
- ထင်ရှားသော mentions ကို ပံ့ပိုးပေးသော မျက်နှာပြင်များတွင် ဆက်လက် ဖြတ်သန်းနိုင်ပြီး pattern များသည် fallback အဖြစ်သာ အသုံးပြုပါသည်။
- အေးဂျင့်အလိုက် override: `agents.list[].groupChat.mentionPatterns` (အေးဂျင့်များစွာက အုပ်စုတစ်ခုကို မျှဝေသုံးစွဲသည့်အခါ အသုံးဝင်ပါသည်)။
- Mention detection လုပ်နိုင်သည့်အခါ (native mentions သို့မဟုတ် `mentionPatterns` ကို စီစဉ်ထားပါက) သာ mention gating ကို အတည်ပြုအကောင်အထည်ဖော်ပါသည်။
- Discord မူလတန်ဖိုးများကို `channels.discord.guilds."*"` အောက်တွင် ထားရှိပြီး guild/ချန်နယ်အလိုက် override လုပ်နိုင်ပါသည်။
- အုပ်စု သမိုင်းကြောင်း context ကို ချန်နယ်များအနှံ့ တစ်သမတ်တည်း wrap လုပ်ထားပြီး **pending-only** ဖြစ်ပါသည် (mention gating ကြောင့် ကျော်လွှားထားသော မက်ဆေ့ချ်များ)။ အထွေထွေ မူလတန်ဖိုးအတွက် `messages.groupChat.historyLimit` ကို၊ override များအတွက် `channels.<channel>.historyLimit` (သို့မဟုတ် `channels.<channel>.accounts.*.historyLimit`) ကို အသုံးပြုပါ။ ပိတ်ရန် `0` ကို သတ်မှတ်ပါ။

## အုပ်စု/ချန်နယ် ကိရိယာ ကန့်သတ်မှုများ (ရွေးချယ်နိုင်)

ချန်နယ် ဖွဲ့စည်းမှုအချို့တွင် **အုပ်စု/room/ချန်နယ် တစ်ခုအတွင်း** အသုံးပြုနိုင်သည့် ကိရိယာများကို ကန့်သတ်နိုင်ပါသည်။

- `tools`: အုပ်စုတစ်ခုလုံးအတွက် ကိရိယာများကို allow/deny ပြုလုပ်ရန်။
- `toolsBySender`: အုပ်စုအတွင်း ပို့သူအလိုက် override များ (ကီးများမှာ ချန်နယ်အလိုက် sender IDs/usernames/emails/ဖုန်းနံပါတ်များ ဖြစ်နိုင်သည်)။ wildcard အဖြစ် `"*"` ကို အသုံးပြုပါ။

ဆုံးဖြတ် အစဉ် (အသေးစိတ်ဆုံးက အနိုင်ရ) —

1. group/channel `toolsBySender` ကိုက်ညီမှု
2. group/channel `tools`
3. မူလ (`"*"`) `toolsBySender` ကိုက်ညီမှု
4. မူလ (`"*"`) `tools`

ဥပမာ (Telegram) —

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

မှတ်ချက်များ —

- အုပ်စု/ချန်နယ် ကိရိယာ ကန့်သတ်မှုများသည် global/agent ကိရိယာ မူဝါဒများအပေါ် ထပ်မံ အကျိုးသက်ရောက်ပါသည် (deny သည် အမြဲ အနိုင်ရပါသည်)။
- ချန်နယ်အချို့တွင် rooms/ချန်နယ်များအတွက် nesting ပုံစံ မတူပါသည် (ဥပမာ — Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`)။

## အုပ်စု ခွင့်ပြုစာရင်းများ

`channels.whatsapp.groups`, `channels.telegram.groups`, သို့မဟုတ် `channels.imessage.groups` ကို စီစဉ်ထားပါက ထိုကီးများသည် အုပ်စု ခွင့်ပြုစာရင်းအဖြစ် လုပ်ဆောင်ပါသည်။ မူလ mention အပြုအမူကို ထားရှိရင်း အုပ်စုအားလုံးကို ခွင့်ပြုလိုပါက `"*"` ကို အသုံးပြုပါ။

အများအားဖြင့် အသုံးပြုသော ရည်ရွယ်ချက်များ (copy/paste) —

1. အုပ်စု ပြန်ကြားမှုအားလုံးကို ပိတ်ရန်

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. သတ်မှတ်ထားသော အုပ်စုများကိုသာ ခွင့်ပြုရန် (WhatsApp)

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

3. အုပ်စုအားလုံးကို ခွင့်ပြုပေမယ့် mention လိုအပ်စေရန် (ထင်ရှားစွာ)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. အုပ်စုများတွင် ပိုင်ရှင်သာ လှုံ့ဆော်နိုင်စေရန် (WhatsApp)

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

## အလုပ်လုပ်စေခြင်း (ပိုင်ရှင်သာ)

အုပ်စု ပိုင်ရှင်များသည် အုပ်စုအလိုက် activation ကို toggle လုပ်နိုင်ပါသည် —

- `/activation mention`
- `/activation always`

ပိုင်ရှင်ကို `channels.whatsapp.allowFrom` ဖြင့် သတ်မှတ်ပါသည် (မသတ်မှတ်ထားပါက bot ၏ ကိုယ်ပိုင် E.164 ကို အသုံးပြုပါသည်)။ အမိန့်ကို သီးသန့် မက်ဆေ့ချ်အဖြစ် ပို့ပါ။ အခြား မျက်နှာပြင်များတွင် ယခုအချိန်တွင် `/activation` ကို မလက်ခံပါ။

## Context အကွက်များ

အုပ်စုမှ ဝင်လာသော payload များတွင် အောက်ပါအရာများကို သတ်မှတ်ပါသည် —

- `ChatType=group`
- `GroupSubject` (သိရှိပါက)
- `GroupMembers` (သိရှိပါက)
- `WasMentioned` (mention gating ရလဒ်)
- Telegram forum topics များတွင် `MessageThreadId` နှင့် `IsForum` ကိုလည်း ထည့်သွင်းပါသည်။

အေးဂျင့် system prompt တွင် အုပ်စု ဆက်ရှင် အသစ်၏ ပထမဆုံး အလှည့်တွင် group intro ကို ထည့်သွင်းပါသည်။ ၎င်းတွင် လူသားလို ပြန်ကြားရန်၊ Markdown ဇယားများကို ရှောင်ရန်၊ literal `\n` အစီအစဉ်များကို မရိုက်ရန် သတိပေးထားပါသည်။

## iMessage အထူးသတ်မှတ်ချက်များ

- Routing သို့မဟုတ် ခွင့်ပြုစာရင်း သတ်မှတ်ရာတွင် `chat_id:<id>` ကို ဦးစားပေး အသုံးပြုပါ။
- ချတ်စာရင်း ပြရန်: `imsg chats --limit 20`။
- အုပ်စု ပြန်ကြားမှုများသည် အမြဲတမ်း အတူတူသော `chat_id` သို့ ပြန်ပို့ပါသည်။

## WhatsApp အထူးသတ်မှတ်ချက်များ

WhatsApp အတွက်သာ သက်ဆိုင်သော အပြုအမူများ (history injection, mention ကိုင်တွယ်ပုံ အသေးစိတ်) အတွက် [Group messages](/channels/group-messages) ကို ကြည့်ပါ။
