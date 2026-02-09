---
summary: "Heartbeat polling မက်ဆေ့ချ်များနှင့် အသိပေးချက် စည်းမျဉ်းများ"
read_when:
  - Heartbeat cadence သို့မဟုတ် မက်ဆေ့ချ်ပို့ပုံကို ချိန်ညှိရာတွင်
  - အချိန်ဇယားထားသော တာဝန်များအတွက် heartbeat နှင့် cron တို့ထဲမှ ရွေးချယ်ရာတွင်
title: "Heartbeat"
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

- 17. Interval: `30m` (Anthropic OAuth/setup-token ကို auth mode အဖြစ် တွေ့ရှိပါက `1h`)။ 18. `agents.defaults.heartbeat.every` သို့မဟုတ် agent တစ်ခုချင်းစီအတွက် `agents.list[].heartbeat.every` ကို သတ်မှတ်ပါ; disable ပြုလုပ်ရန် `0m` ကို အသုံးပြုပါ။
- Prompt body (`agents.defaults.heartbeat.prompt` မှတစ်ဆင့် ပြင်ဆင်နိုင်သည်):
  `Read HEARTBEAT.md if it exists (workspace context). 20. ၎င်းကို တိတိကျကျ လိုက်နာပါ။ 21. ယခင် chat များမှ အလုပ်များကို ခန့်မှန်းခြင်း သို့မဟုတ် ထပ်မံ ပြောကြားခြင်း မပြုလုပ်ပါနှင့်။ အာရုံစိုက်ရန် အရာမရှိပါက `HEARTBEAT_OK.\` ဟုပြန်လည်ဖြေကြားပါ။
- 23. Heartbeat prompt ကို user message အဖြစ် **verbatim** ပို့ပေးပါသည်။ System prompt တွင် “Heartbeat” အပိုင်းပါဝင်ပြီး run ကို အတွင်းပိုင်းအနေဖြင့် flag ပြုလုပ်ထားပါသည်။
- 25. Active hours (`heartbeat.activeHours`) ကို သတ်မှတ်ထားသော timezone အရ စစ်ဆေးပါသည်။
  26. အချိန်ကန့်သတ်ချက် အပြင်ဘက်တွင် heartbeats များကို နောက်တစ်ကြိမ် tick အတွင်းသို့ ဝင်ရောက်သည်အထိ ကျော်သွားပါသည်။

## Heartbeat prompt ရဲ့ ရည်ရွယ်ချက်

ပုံမှန် prompt သည် ရည်ရွယ်ချက်အရ ကျယ်ပြန့်စွာ ထားရှိထားသည်။

- **Background tasks**: “Consider outstanding tasks” သည် agent ကို လိုက်နာရန် ကျန်ရှိနေသော အလုပ်များ (inbox, calendar, reminders, queued work) ကို ပြန်လည်စစ်ဆေးပြီး အရေးပေါ်အရာများကို ထုတ်ဖော်စေရန် လှုံ့ဆော်သည်။
- 27. **Human check-in**: “Checkup sometimes on your human during day time” သည် နေ့အချိန်တွင် အခါအားလျော်စွာ ပေါ့ပါးသော “ဘာလိုအပ်ပါသလဲ?” မေးခွန်းကို ပို့ပေးပြီး သတ်မှတ်ထားသော local timezone ကို အသုံးပြု၍ ညအချိန် spam မဖြစ်စေရန် ရှောင်ရှားပါသည် (see [/concepts/timezone](/concepts/timezone))။

Heartbeat ကို အလွန်တိကျသည့် အလုပ်တစ်ခုလုပ်စေလိုပါက (ဥပမာ “check Gmail PubSub stats” သို့မဟုတ် “verify gateway health”) `agents.defaults.heartbeat.prompt` (သို့မဟုတ် `agents.list[].heartbeat.prompt`) ကို custom body အဖြစ် သတ်မှတ်နိုင်ပါသည် (verbatim ပို့သည်)။

## Response contract

- သတိထားရန် မလိုအပ်ပါက **`HEARTBEAT_OK`** ဖြင့် ပြန်ကြားပါ။
- 28. Heartbeat run များအတွင်း OpenClaw သည် `HEARTBEAT_OK` ကို reply ၏ **အစ သို့မဟုတ် အဆုံး** တွင် ပေါ်လာပါက ack အဖြစ် လက်ခံပါသည်။ 29. Token ကို ဖယ်ရှားပြီး ကျန်ရှိသော content သည် **≤ `ackMaxChars`** (default: 300) ဖြစ်ပါက reply ကို drop လုပ်ပါသည်။
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
- 30. `channels.<channel>`31. `.heartbeat` သည် channel default များကို override ပြုလုပ်ပါသည်။
- 32. `channels.<channel>`33. `.accounts.<id>``.heartbeat` (multi-account channels) သည် channel တစ်ခုချင်းစီ၏ setting များကို override လုပ်ပါသည်။

### Per-agent heartbeats

35. `agents.list[]` entry တစ်ခုခုတွင် `heartbeat` block ပါရှိပါက **ထို agent များသာ** heartbeat ကို run လုပ်ပါသည်။ 36. Agent တစ်ခုချင်းစီ၏ block သည် `agents.defaults.heartbeat` အပေါ်တွင် merge လုပ်ပါသည် (shared default များကို တစ်ကြိမ်သာ သတ်မှတ်ပြီး agent အလိုက် override ပြုလုပ်နိုင်ပါသည်)။

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

37. ဤ window အပြင်ဘက်တွင် (Eastern အချိန် မနက် 9 နာရီမတိုင်မီ သို့မဟုတ် ည 10 နာရီနောက်ပိုင်း) heartbeats များကို ကျော်သွားပါသည်။ 38. Window အတွင်းသို့ ဝင်ရောက်သည့် နောက်တစ်ကြိမ် scheduled tick တွင် ပုံမှန်အတိုင်း run လုပ်ပါသည်။

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
- 39. `accountId`: multi-account channel များအတွက် optional account id ဖြစ်ပါသည်။ 40. `target: "last"` ဖြစ်ပါက account id သည် account များကို ထောက်ပံ့သော resolved last channel တွင်သာ သက်ဆိုင်ပြီး မထောက်ပံ့ပါက လျစ်လျူရှုပါသည်။ 41. Account id သည် resolved channel အတွက် config ပြုလုပ်ထားသော account နှင့် မကိုက်ညီပါက delivery ကို ကျော်သွားပါသည်။
- `prompt`: default prompt body ကို override လုပ်သည် (merge မလုပ်ပါ)။
- `ackMaxChars`: `HEARTBEAT_OK` နောက်ပိုင်း ပို့မည့်အခါ ခွင့်ပြုထားသော အများဆုံး characters။
- 42. `activeHours`: heartbeat run များကို အချိန်ကန့်သတ်ချက်အတွင်းသာ ချုပ်ချယ်ပါသည်။ 43. `start` (HH:MM, inclusive), `end` (HH:MM exclusive; နေ့အဆုံးအတွက် `24:00` ကို ခွင့်ပြုသည်) နှင့် optional `timezone` ပါဝင်သော object ဖြစ်ပါသည်။
  - ဖယ်ရှားထားပါက သို့မဟုတ် `"user"`: `agents.defaults.userTimezone` ကို သတ်မှတ်ထားပါက အသုံးပြုပြီး မရှိပါက host system timezone သို့ ပြန်လည်ကျရောက်မည်။
  - `"local"`: host system timezone ကို အမြဲအသုံးပြုသည်။
  - မည်သည့် IANA identifier မဆို (ဥပမာ `America/New_York`): တိုက်ရိုက် အသုံးပြုမည်၊ မမှန်ကန်ပါက အထက်ပါ `"user"` အပြုအမူသို့ ပြန်လည်ကျရောက်မည်။
  - Active window ပြင်ပတွင် heartbeats များကို ကျော်လွှားထားပြီး နောက်တစ်ကြိမ် အချိန်အတွင်း tick ဖြစ်သည့်အထိ စောင့်မည်။

## Delivery behavior

- 44. Heartbeat များသည် default အနေဖြင့် agent ၏ main session (`agent:<id>:<mainKey>`) တွင် run လုပ်ပြီး `session.scope = "global"` ဖြစ်ပါက `global` ကို အသုံးပြုပါသည်။ Channel session တစ်ခုကို သတ်မှတ်၍ override လုပ်ရန် `session` ကို သတ်မှတ်ပါ (Discord/WhatsApp စသည်)။
- `session` သည် run context ကိုသာ သက်ရောက်စေပြီး delivery ကို `target` နှင့် `to` မှ ထိန်းချုပ်သည်။
- 46. သီးခြား channel/recipient သို့ ပို့ရန် `target` + `to` ကို သတ်မှတ်ပါ။ 47. `target: "last"` ဖြင့် delivery သည် ထို session အတွက် နောက်ဆုံး အသုံးပြုခဲ့သော external channel ကို အသုံးပြုပါသည်။
- Main queue အလုပ်များနေပါက heartbeat ကို ကျော်လွှားပြီး နောက်မှ ပြန်ကြိုးစားမည်။
- `target` သည် external destination မရှိပါက run ကို ဆက်လုပ်သော်လည်း outbound မက်ဆေ့ချ် မပို့ပါ။
- Heartbeat-only ပြန်ကြားချက်များသည် session ကို အသက်ရှင်စေမထားဘဲ နောက်ဆုံး `updatedAt` ကို ပြန်လည်ထားရှိသဖြင့် idle expiry သည် ပုံမှန်အတိုင်း ဖြစ်မည်။

## Visibility controls

48. Default အနေဖြင့် alert content ကို ပို့နေစဉ် `HEARTBEAT_OK` acknowledgment များကို ဖိနှိပ်ထားပါသည်။ 49. Channel သို့မဟုတ် account အလိုက် ဤအပြုအမူကို ပြင်ဆင်နိုင်ပါသည်။

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

| Goal                                                                  | Config                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ပုံမှန်အပြုအမူ (OK များကို တိတ်ဆိတ်၊ alerts ဖွင့်) | _(config မလိုအပ်)_                                                    |
| လုံးဝ တိတ်ဆိတ် (မက်ဆေ့ချ်မရှိ၊ indicator မရှိ)     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (မက်ဆေ့ချ်မရှိ)                     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| ချန်နယ်တစ်ခုတွင်သာ OK များ                                            | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optional)

50. Workspace တွင် `HEARTBEAT.md` file ရှိပါက default prompt သည် agent ကို ၎င်းကို ဖတ်ရန် ညွှန်ကြားပါသည်။ Think of it as your “heartbeat checklist”: small, stable, and
    safe to include every 30 minutes.

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
ဖိုင် မရှိပါက heartbeat သည် ဆက်လက် လည်ပတ်ပြီး မော်ဒယ်က ဘာလုပ်မည်ကို ဆုံးဖြတ်ပါသည်။

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

When enabled, heartbeats will also deliver a separate message prefixed
`Reasoning:` (same shape as `/reasoning on`). Agent က session/codex များစွာကို စီမံခန့်ခွဲနေစဉ် သင့်အား ping လုပ်ရန် ဆုံးဖြတ်ခဲ့ရသည့် အကြောင်းရင်းကို မြင်လိုပါက အသုံးဝင်နိုင်ပါသည် — သို့သော် သင်မလိုလားသော အတွင်းပိုင်း အသေးစိတ်အချက်အလက်များ ပေါက်ကြားနိုင်ပါသည်။ Prefer keeping it
off in group chats.

## Cost awareness

Heartbeats run full agent turns. Shorter intervals burn more tokens. Keep
`HEARTBEAT.md` small and consider a cheaper `model` or `target: "none"` if you
only want internal state updates.
