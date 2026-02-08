---
summary: "Heartbeat polling မက်ဆေ့ချ်များနှင့် အသိပေးချက် စည်းမျဉ်းများ"
read_when:
  - Heartbeat cadence သို့မဟုတ် မက်ဆေ့ချ်ပို့ပုံကို ချိန်ညှိရာတွင်
  - အချိန်ဇယားထားသော တာဝန်များအတွက် heartbeat နှင့် cron တို့ထဲမှ ရွေးချယ်ရာတွင်
title: "Heartbeat"
x-i18n:
  source_path: gateway/heartbeat.md
  source_hash: e763caf86ef74488
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:00Z
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** တစ်ခုချင်းစီကို ဘယ်အချိန်မှာ အသုံးပြုသင့်သည်ကို လမ်းညွှန်ချက်ရယူရန် [Cron vs Heartbeat](/automation/cron-vs-heartbeat) ကို ကြည့်ပါ။

Heartbeat သည် အဓိက ဆက်ရှင်အတွင်း **အချိန်ကာလအလိုက် agent turns များ** ကို လုပ်ဆောင်ပေးပြီး မော်ဒယ်အနေဖြင့် သတိထားရန်လိုအပ်သည့် အရာများကို သင့်ကို spam မလုပ်ဘဲ ဖော်ထုတ်နိုင်စေရန် ရည်ရွယ်ထားသည်။

ပြဿနာဖြေရှင်းခြင်း: [/automation/troubleshooting](/automation/troubleshooting)

## Quick start (beginner)

1. Heartbeat ကို ဖွင့်ထားပါ (ပုံမှန်တန်ဖိုးမှာ `30m` ဖြစ်ပြီး Anthropic OAuth/setup-token အတွက် `1h`) သို့မဟုတ် သင့်ကိုယ်ပိုင် cadence ကို သတ်မှတ်ပါ။
2. Agent workspace အတွင်း `HEARTBEAT.md` checklist အသေးတစ်ခုကို ဖန်တီးပါ (မလိုအပ်သော်လည်း အကြံပြုပါသည်)။
3. Heartbeat မက်ဆေ့ချ်များကို ဘယ်နေရာသို့ ပို့မလဲ ဆုံးဖြတ်ပါ (`target: "last"` သည် ပုံမှန်တန်ဖိုး)။
4. မလိုအပ်ပါက heartbeat reasoning delivery ကို ဖွင့်ပြီး ထင်ရှားမြင်သာမှု ရယူနိုင်သည်။
5. မလိုအပ်ပါက heartbeat ကို အလုပ်လုပ်ချိန်များ (local time) အတွင်းသာ ကန့်သတ်နိုင်သည်။

Config ဥပမာ:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Defaults

- Interval: `30m` (Anthropic OAuth/setup-token ကို auth mode အဖြစ် တွေ့ရှိသောအခါ `1h`)။ `agents.defaults.heartbeat.every` သို့မဟုတ် agent တစ်ခုချင်းစီအလိုက် `agents.list[].heartbeat.every` ကို သတ်မှတ်နိုင်ပြီး ပိတ်ရန် `0m` ကို အသုံးပြုပါ။
- Prompt body (`agents.defaults.heartbeat.prompt` မှတစ်ဆင့် ပြင်ဆင်နိုင်သည်):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Heartbeat prompt ကို user message အဖြစ် **အတိအကျ 그대로** ပို့သည်။ System prompt တွင် “Heartbeat” အပိုင်း ပါဝင်ပြီး run ကို အတွင်းပိုင်းအဖြစ် အမှတ်အသားပြုထားသည်။
- Active hours (`heartbeat.activeHours`) ကို သတ်မှတ်ထားသော timezone အတွင်း စစ်ဆေးသည်။ သတ်မှတ်ထားသော အချိန်ပြင်ပတွင် heartbeats များကို နောက်တစ်ကြိမ် အချိန်အတွင်း tick ဖြစ်သည့်အထိ ကျော်လွှားထားမည်ဖြစ်သည်။

## Heartbeat prompt ရဲ့ ရည်ရွယ်ချက်

ပုံမှန် prompt သည် ရည်ရွယ်ချက်အရ ကျယ်ပြန့်စွာ ထားရှိထားသည်။

- **Background tasks**: “Consider outstanding tasks” သည် agent ကို လိုက်နာရန် ကျန်ရှိနေသော အလုပ်များ (inbox, calendar, reminders, queued work) ကို ပြန်လည်စစ်ဆေးပြီး အရေးပေါ်အရာများကို ထုတ်ဖော်စေရန် လှုံ့ဆော်သည်။
- **Human check-in**: “Checkup sometimes on your human during day time” သည် တစ်ခါတစ်ရံ “ဘာလိုအပ်ပါသလဲ?” ဟု ပေါ့ပါးသော မေးမြန်းချက် ပို့စေရန် လှုံ့ဆော်ပြီး သတ်မှတ်ထားသော local timezone ကို အသုံးပြုကာ ညအချိန် spam မဖြစ်စေရန် ကာကွယ်ထားသည် ([/concepts/timezone](/concepts/timezone) ကို ကြည့်ပါ)။

Heartbeat ကို အလွန်တိကျသည့် အလုပ်တစ်ခုလုပ်စေလိုပါက (ဥပမာ “check Gmail PubSub stats” သို့မဟုတ် “verify gateway health”) `agents.defaults.heartbeat.prompt` (သို့မဟုတ် `agents.list[].heartbeat.prompt`) ကို custom body အဖြစ် သတ်မှတ်နိုင်ပါသည် (verbatim ပို့သည်)။

## Response contract

- သတိထားရန် မလိုအပ်ပါက **`HEARTBEAT_OK`** ဖြင့် ပြန်ကြားပါ။
- Heartbeat run အတွင်း OpenClaw သည် `HEARTBEAT_OK` ကို ပြန်ကြားချက်၏ **အစ သို့မဟုတ် အဆုံး** တွင် တွေ့ရှိပါက ack အဖြစ် သတ်မှတ်သည်။ Token ကို ဖယ်ရှားပြီး ကျန်ရှိသော အကြောင်းအရာသည် **≤ `ackMaxChars`** (ပုံမှန်: 300) ဖြစ်ပါက reply ကို ပယ်ချမည်။
- `HEARTBEAT_OK` သည် ပြန်ကြားချက်၏ **အလယ်** တွင် ပါရှိပါက အထူးအဖြစ် မယူဆပါ။
- Alert များအတွက် **`HEARTBEAT_OK` မထည့်ပါနှင့်**; alert စာသားကိုသာ ပြန်ပို့ပါ။

Heartbeat မဟုတ်သည့် အခြေအနေတွင် မက်ဆေ့ချ်အစ/အဆုံး၌ မလိုလားအပ်သော `HEARTBEAT_OK` ရှိပါက ဖယ်ရှားပြီး မှတ်တမ်းတင်မည်ဖြစ်ပြီး `HEARTBEAT_OK` တစ်ခုတည်းသာ ပါသော မက်ဆေ့ချ်ကို ပယ်ချမည်ဖြစ်သည်။

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Scope and precedence

- `agents.defaults.heartbeat` သည် global heartbeat အပြုအမူကို သတ်မှတ်သည်။
- `agents.list[].heartbeat` သည် အပေါ်မှ ပေါင်းစည်းပြီး မည်သည့် agent တွင်မဆို `heartbeat` block ရှိပါက **ထို agent များသာ** heartbeats ကို လုပ်ဆောင်မည်။
- `channels.defaults.heartbeat` သည် ချန်နယ်အားလုံးအတွက် visibility defaults ကို သတ်မှတ်သည်။
- `channels.<channel>.heartbeat` သည် ချန်နယ် default များကို override လုပ်သည်။
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account channels) သည် per-channel settings ကို override လုပ်သည်။

### Per-agent heartbeats

မည်သည့် `agents.list[]` entry တွင်မဆို `heartbeat` block ပါရှိပါက **ထို agent များသာ** heartbeats ကို လုပ်ဆောင်မည်ဖြစ်သည်။ Per-agent block သည် `agents.defaults.heartbeat` အပေါ်မှ ပေါင်းစည်းသဖြင့် (shared defaults ကို တစ်ကြိမ်သာ သတ်မှတ်ပြီး agent တစ်ခုချင်းစီအလိုက် override လုပ်နိုင်သည်)။

ဥပမာ: agent နှစ်ခုရှိပြီး ဒုတိယ agent တစ်ခုသာ heartbeats ကို လုပ်ဆောင်သည်။

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Active hours example

Timezone တစ်ခုအတွင်း အလုပ်ချိန်များသို့သာ heartbeats ကို ကန့်သတ်ခြင်း:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

ဤအချိန်ပြင်ပတွင် (Eastern အချိန် 9am မတိုင်မီ သို့မဟုတ် 10pm နောက်ပိုင်း) heartbeats များကို ကျော်လွှားထားပြီး နောက်တစ်ကြိမ် သတ်မှတ်အချိန်အတွင်း tick ဖြစ်ပါက ပုံမှန်အတိုင်း လုပ်ဆောင်မည်ဖြစ်သည်။

### Multi account example

Telegram ကဲ့သို့ multi-account channels များတွင် အကောင့်တစ်ခုကို ပစ်မှတ်ထားရန် `accountId` ကို အသုံးပြုပါ။

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Field notes

- `every`: heartbeat interval (duration string; ပုံမှန် unit = minutes)။
- `model`: heartbeat runs အတွက် optional model override (`provider/model`)။
- `includeReasoning`: ဖွင့်ထားပါက သီးခြား `Reasoning:` မက်ဆေ့ချ်ကို ရရှိသည့်အခါ ပို့ပေးသည် (`/reasoning on` နှင့် ပုံစံတူ)။
- `session`: heartbeat runs အတွက် optional session key။
  - `main` (ပုံမှန်): agent main session။
  - Explicit session key (`openclaw sessions --json` သို့မဟုတ် [sessions CLI](/cli/sessions) မှ ကူးယူနိုင်သည်)။
  - Session key ပုံစံများအတွက် [Sessions](/concepts/session) နှင့် [Groups](/channels/groups) ကို ကြည့်ပါ။
- `target`:
  - `last` (ပုံမှန်): နောက်ဆုံး အသုံးပြုထားသော external channel သို့ ပို့သည်။
  - explicit channel: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`။
  - `none`: heartbeat ကို run လုပ်သော်လည်း external သို့ **မပို့ပါ**။
- `to`: optional recipient override (channel-specific id; ဥပမာ WhatsApp အတွက် E.164 သို့မဟုတ် Telegram chat id)။
- `accountId`: multi-account channels အတွက် optional account id။ `target: "last"` ဖြစ်ပါက account id ကို resolved last channel သို့ သက်ဆိုင်ရာ အကောင့်များကို ပံ့ပိုးပါက အသုံးချမည်၊ မပံ့ပိုးပါက လျစ်လျူရှုမည်။ Account id သည် resolved channel အတွက် သတ်မှတ်ထားသော အကောင့်နှင့် မကိုက်ညီပါက ပို့ခြင်းကို ကျော်လွှားမည်။
- `prompt`: default prompt body ကို override လုပ်သည် (merge မလုပ်ပါ)။
- `ackMaxChars`: `HEARTBEAT_OK` နောက်ပိုင်း ပို့မည့်အခါ ခွင့်ပြုထားသော အများဆုံး characters။
- `activeHours`: heartbeat runs ကို အချိန်ကန့်သတ်ချက်တစ်ခုအတွင်းသာ ကန့်သတ်သည်။ `start` (HH:MM, inclusive), `end` (HH:MM exclusive; အဆုံးနေ့အတွက် `24:00` ခွင့်ပြု), နှင့် optional `timezone` ပါဝင်သည့် object။
  - ဖယ်ရှားထားပါက သို့မဟုတ် `"user"`: `agents.defaults.userTimezone` ကို သတ်မှတ်ထားပါက အသုံးပြုပြီး မရှိပါက host system timezone သို့ ပြန်လည်ကျရောက်မည်။
  - `"local"`: host system timezone ကို အမြဲအသုံးပြုသည်။
  - မည်သည့် IANA identifier မဆို (ဥပမာ `America/New_York`): တိုက်ရိုက် အသုံးပြုမည်၊ မမှန်ကန်ပါက အထက်ပါ `"user"` အပြုအမူသို့ ပြန်လည်ကျရောက်မည်။
  - Active window ပြင်ပတွင် heartbeats များကို ကျော်လွှားထားပြီး နောက်တစ်ကြိမ် အချိန်အတွင်း tick ဖြစ်သည့်အထိ စောင့်မည်။

## Delivery behavior

- Heartbeats များကို ပုံမှန်အားဖြင့် agent ၏ main session (`agent:<id>:<mainKey>`) တွင် run လုပ်သည်၊ သို့မဟုတ် `session.scope = "global"` ဖြစ်ပါက `global` တွင် run လုပ်သည်။ သတ်မှတ်ချန်နယ် session (Discord/WhatsApp စသည်) သို့ override လုပ်ရန် `session` ကို သတ်မှတ်ပါ။
- `session` သည် run context ကိုသာ သက်ရောက်စေပြီး delivery ကို `target` နှင့် `to` မှ ထိန်းချုပ်သည်။
- သတ်မှတ်ချန်နယ်/လက်ခံသူထံ ပို့ရန် `target` + `to` ကို သတ်မှတ်ပါ။ `target: "last"` ဖြင့် ထို session အတွက် နောက်ဆုံး external channel ကို အသုံးပြု၍ ပို့မည်။
- Main queue အလုပ်များနေပါက heartbeat ကို ကျော်လွှားပြီး နောက်မှ ပြန်ကြိုးစားမည်။
- `target` သည် external destination မရှိပါက run ကို ဆက်လုပ်သော်လည်း outbound မက်ဆေ့ချ် မပို့ပါ။
- Heartbeat-only ပြန်ကြားချက်များသည် session ကို အသက်ရှင်စေမထားဘဲ နောက်ဆုံး `updatedAt` ကို ပြန်လည်ထားရှိသဖြင့် idle expiry သည် ပုံမှန်အတိုင်း ဖြစ်မည်။

## Visibility controls

ပုံမှန်အားဖြင့် `HEARTBEAT_OK` acknowledgments များကို ဖျောက်ထားပြီး alert အကြောင်းအရာများကိုသာ ပို့ပေးသည်။ ၎င်းကို ချန်နယ်တစ်ခုချင်းစီ သို့မဟုတ် account တစ်ခုချင်းစီအလိုက် ချိန်ညှိနိုင်သည်။

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedence: per-account → per-channel → channel defaults → built-in defaults။

### Flag တစ်ခုချင်းစီ၏ လုပ်ဆောင်ချက်

- `showOk`: မော်ဒယ်က OK-only ပြန်ကြားချက် ပြန်ပို့သောအခါ `HEARTBEAT_OK` acknowledgment ကို ပို့သည်။
- `showAlerts`: မော်ဒယ်က non-OK ပြန်ကြားချက် ပြန်ပို့သောအခါ alert အကြောင်းအရာကို ပို့သည်။
- `useIndicator`: UI status surfaces အတွက် indicator events များကို ထုတ်ပေးသည်။

**သုံးခုလုံး** false ဖြစ်ပါက OpenClaw သည် heartbeat run ကို လုံးဝ ကျော်လွှားမည် (model call မလုပ်ပါ)။

### Per-channel vs per-account ဥပမာများ

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Common patterns

| Goal                                               | Config                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ပုံမှန်အပြုအမူ (OK များကို တိတ်ဆိတ်၊ alerts ဖွင့်) | _(config မလိုအပ်)_                                                                       |
| လုံးဝ တိတ်ဆိတ် (မက်ဆေ့ချ်မရှိ၊ indicator မရှိ)     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (မက်ဆေ့ချ်မရှိ)                     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| ချန်နယ်တစ်ခုတွင်သာ OK များ                         | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optional)

Workspace အတွင်း `HEARTBEAT.md` ဖိုင် ရှိပါက ပုံမှန် prompt သည် agent ကို ၎င်းကို ဖတ်ရန် ညွှန်ကြားသည်။ ၎င်းကို “heartbeat checklist” ဟု စဉ်းစားနိုင်ပြီး သေးငယ်၊ တည်ငြိမ်ပြီး မိနစ် 30 တစ်ကြိမ် ပါဝင်စေရန် လုံခြုံပါသည်။

`HEARTBEAT.md` ရှိသော်လည်း အမှန်တကယ် အလွတ်ဖြစ်နေပါက (အလွတ်လိုင်းများနှင့် `# Heading` ကဲ့သို့ markdown headers များသာ) OpenClaw သည် API calls ကို ချွေတာရန် heartbeat run ကို ကျော်လွှားမည်။ ဖိုင် မရှိပါက heartbeat သည် ဆက်လက် run လုပ်ပြီး မော်ဒယ်က ဘာလုပ်မလဲ ဆုံးဖြတ်မည်။

Prompt အရွယ်အစား မတိုးစေရန် သေးငယ်စွာ ထားပါ (short checklist သို့မဟုတ် reminders)။

`HEARTBEAT.md` ဥပမာ:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Agent က HEARTBEAT.md ကို update လုပ်နိုင်ပါသလား?

လုပ်နိုင်ပါသည် — သင်က တောင်းဆိုပါက။

`HEARTBEAT.md` သည် agent workspace အတွင်းရှိ ပုံမှန်ဖိုင်တစ်ခုသာ ဖြစ်သောကြောင့် သင်သည် (ပုံမှန် chat အတွင်း) agent ကို အောက်ပါကဲ့သို့ ပြောနိုင်ပါသည်။

- “`HEARTBEAT.md` ကို update လုပ်ပြီး နေ့စဉ် calendar စစ်ဆေးချက် ထည့်ပါ။”
- “`HEARTBEAT.md` ကို ပိုတိုပြီး inbox follow-ups အပေါ် အာရုံစိုက်စေဖို့ ပြန်ရေးပါ။”

Proactive ဖြစ်စေလိုပါက heartbeat prompt ထဲတွင် “Checklist ဟောင်းလာပါက HEARTBEAT.md ကို ပိုကောင်းသော checklist တစ်ခုဖြင့် update လုပ်ပါ” ဟု တိတိကျကျ ထည့်နိုင်ပါသည်။

လုံခြုံရေး မှတ်ချက်: `HEARTBEAT.md` ထဲတွင် လျှို့ဝှက်ချက်များ (API keys, ဖုန်းနံပါတ်များ, private tokens) မထည့်ပါနှင့် — ၎င်းသည် prompt context ၏ အစိတ်အပိုင်း ဖြစ်သွားမည်ဖြစ်သည်။

## Manual wake (on-demand)

အောက်ပါအတိုင်း system event တစ်ခုကို enqueue လုပ်၍ ချက်ချင်း heartbeat ကို trigger လုပ်နိုင်ပါသည်။

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Agents အများအပြားတွင် `heartbeat` ကို သတ်မှတ်ထားပါက manual wake သည် ထို agent heartbeats များအားလုံးကို ချက်ချင်း run လုပ်မည်။

နောက်တစ်ကြိမ် သတ်မှတ်ထားသော tick ကို စောင့်ရန် `--mode next-heartbeat` ကို အသုံးပြုပါ။

## Reasoning delivery (optional)

ပုံမှန်အားဖြင့် heartbeats များသည် နောက်ဆုံး “answer” payload ကိုသာ ပို့ပေးသည်။

ထင်ရှားမြင်သာမှု လိုအပ်ပါက အောက်ပါကို ဖွင့်ပါ။

- `agents.defaults.heartbeat.includeReasoning: true`

ဖွင့်ထားပါက heartbeats များသည် `Reasoning:` ဖြင့် အစပြုသော သီးခြား မက်ဆေ့ချ်တစ်ခုကိုပါ ပို့မည်ဖြစ်သည် (`/reasoning on` နှင့် ပုံစံတူ)။ Agent သည် sessions/codexes များစွာကို စီမံခန့်ခွဲနေသည့်အခါ ဘာကြောင့် သင့်ကို ping လုပ်ရသည်ကို သိရန် အသုံးဝင်နိုင်သော်လည်း သင် မလိုချင်သည့် အတွင်းပိုင်းအသေးစိတ်များကို ဖော်ထုတ်နိုင်ပါသည်။ Group chats များတွင် ပိတ်ထားခြင်းကို ဦးစားပေးပါ။

## Cost awareness

Heartbeats များသည် full agent turns ကို run လုပ်သည်။ Interval တိုလေလေ token အသုံးစရိတ် ပိုများလေလေ ဖြစ်သည်။ `HEARTBEAT.md` ကို သေးငယ်စွာ ထားပြီး အတွင်းပိုင်း state updates သာ လိုအပ်ပါက ပိုစျေးသက်သာသော `model` သို့မဟုတ် `target: "none"` ကို စဉ်းစားပါ။
