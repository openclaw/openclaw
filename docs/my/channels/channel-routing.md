---
summary: "ချန်နယ်အလိုက် လမ်းကြောင်းချမှတ်မှု စည်းမျဉ်းများ (WhatsApp, Telegram, Discord, Slack) နှင့် မျှဝေထားသော အကြောင်းအရာအခြေအနေ"
read_when:
  - ချန်နယ် လမ်းကြောင်းချမှတ်မှု သို့မဟုတ် inbox အပြုအမူကို ပြောင်းလဲသည့်အခါ
title: "ချန်နယ် လမ်းကြောင်းချမှတ်မှု"
---

# ချန်နယ်များ & လမ်းကြောင်းချမှတ်မှု

OpenClaw သည် အဖြေများကို **မက်ဆေ့ချ် လာခဲ့သော ချန်နယ်သို့ ပြန်ပို့ပါသည်**။ မော်ဒယ်သည် ချန်နယ်ကို မရွေးချယ်ပါ။ လမ်းကြောင်းချခြင်းသည် တိကျသေချာပြီး host configuration မှ ထိန်းချုပ်ထားပါသည်။

## အဓိက စကားလုံးများ

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`။
- **AccountId**: ချန်နယ်အလိုက် အကောင့် instance (ထောက်ပံ့ထားသောအခါ)။
- **AgentId**: သီးခြား workspace + session store (“ဦးနှောက်”)။
- **SessionKey**: အကြောင်းအရာသိုလှောင်ရန်နှင့် concurrency ကို ထိန်းချုပ်ရန် အသုံးပြုသော bucket key။

## Session key ပုံစံများ (ဥပမာများ)

Direct messages များသည် အေးဂျင့်၏ **main** session သို့ ပေါင်းစည်းထားသည်—

- `agent:<agentId>:<mainKey>` (မူလတန်ဖိုး: `agent:main:main`)

အုပ်စုများနှင့် ချန်နယ်များသည် ချန်နယ်အလိုက် သီးခြားထားရှိသည်—

- Groups: `agent:<agentId>:<channel>:group:<id>`
- Channels/rooms: `agent:<agentId>:<channel>:channel:<id>`

Threads—

- Slack/Discord threads များတွင် base key သို့ `:thread:<threadId>` ကို ထပ်တိုးသည်။
- Telegram forum topics များတွင် group key အတွင်း `:topic:<topicId>` ကို ထည့်သွင်းထားသည်။

ဥပမာများ—

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## လမ်းကြောင်းချမှတ်မှု စည်းမျဉ်းများ (အေးဂျင့်ကို ဘယ်လိုရွေးချယ်သလဲ)

Inbound မက်ဆေ့ချ် တစ်ခုစီအတွက် **အေးဂျင့်တစ်ခု** ကို လမ်းကြောင်းချမှတ်သည်—

1. **တိကျသော peer ကိုက်ညီမှု** (`bindings` နှင့် `peer.kind` + `peer.id`)။
2. **Guild ကိုက်ညီမှု** (Discord) — `guildId` မှတဆင့်။
3. **Team ကိုက်ညီမှု** (Slack) — `teamId` မှတဆင့်။
4. **Account ကိုက်ညီမှု** (ချန်နယ်ပေါ်ရှိ `accountId`)။
5. **Channel ကိုက်ညီမှု** (ထိုချန်နယ်ပေါ်ရှိ မည်သည့် account မဆို)။
6. **Default agent** (`agents.list[].default`, မဟုတ်ပါက စာရင်းထဲ ပထမဆုံး အချက်အလက်၊ နောက်ဆုံး fallback အဖြစ် `main`)။

ကိုက်ညီသည့် အေးဂျင့်က အသုံးပြုမည့် workspace နှင့် session store ကို သတ်မှတ်ပေးသည်။

## Broadcast groups (အေးဂျင့်များစွာကို လည်ပတ်စေခြင်း)

Broadcast groups သည် OpenClaw ပုံမှန်အားဖြင့် ပြန်ကြားပေးမည့် အခြေအနေများတွင် (ဥပမာ— WhatsApp အုပ်စုများတွင် mention/activation gating ပြီးနောက်) peer တစ်ခုအတွက် **အေးဂျင့်များစွာ** ကို လည်ပတ်စေနိုင်သည်။

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

ကြည့်ရန်: [Broadcast Groups](/channels/broadcast-groups)။

## Config အကျဉ်းချုပ်

- `agents.list`: အမည်ပေးထားသော အေးဂျင့် သတ်မှတ်ချက်များ (workspace, model စသည်)။
- `bindings`: inbound ချန်နယ်များ/အကောင့်များ/peers များကို အေးဂျင့်များနှင့် ချိတ်ဆက်သော map။

ဥပမာ—

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

## Session သိုလှောင်မှု

Session stores များသည် state directory အောက်တွင် တည်ရှိသည် (မူလတန်ဖိုး `~/.openclaw`)—

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL transcripts များသည် store နှင့် အတူ တည်ရှိသည်

`session.store` နှင့် `{agentId}` templating ကို အသုံးပြုပြီး store လမ်းကြောင်းကို override ပြုလုပ်နိုင်သည်။

## WebChat အပြုအမူ

WebChat သည် **ရွေးချယ်ထားသော အေးဂျင့်** နှင့် ချိတ်ဆက်ပြီး အေးဂျင့်၏ အဓိက session ကို မူလအဖြစ် အသုံးပြုပါသည်။ ထို့ကြောင့် WebChat သည် အေးဂျင့်တစ်ခုအတွက် ချန်နယ်အနှံ့ context ကို တစ်နေရာတည်းတွင် မြင်နိုင်စေပါသည်။

## Reply အကြောင်းအရာအခြေအနေ

Inbound replies များတွင် ပါဝင်သည်—

- ရရှိနိုင်ပါက `ReplyToId`, `ReplyToBody`, နှင့် `ReplyToSender`။
- Quote ပြုလုပ်ထားသော အကြောင်းအရာကို `Body` သို့ `[Replying to ...]` block အဖြစ် ထပ်တိုးထည့်သွင်းသည်။

ဤအပြုအမူသည် ချန်နယ်အားလုံးတွင် တူညီသည်။
