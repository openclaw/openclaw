---
summary: "စာအိတ်များ၊ prompt များ၊ tools များနှင့် connectors များအတွင်း ရက်စွဲနှင့် အချိန်ကို ကိုင်တွယ်ပုံ"
read_when:
  - မော်ဒယ် သို့မဟုတ် အသုံးပြုသူများထံ အချိန်တံဆိပ်များကို ပြသပုံ ပြောင်းလဲနေသောအခါ
  - မက်ဆေ့ချ်များ သို့မဟုတ် စနစ် prompt အထွက်တွင် အချိန်ဖော်မတ်ကို ပြဿနာရှာဖွေနေသောအခါ
title: "ရက်စွဲနှင့် အချိန်"
---

# ရက်စွဲ & အချိန်

OpenClaw သည် **transport timestamps အတွက် host-local time** ကို ပုံမှန်အသုံးပြုပြီး **system prompt အတွင်းတွင်သာ user timezone** ကို အသုံးပြုပါသည်။
provider timestamps များကို ထိန်းသိမ်းထားသောကြောင့် tools များ၏ native semantics ကို ဆက်လက်အသုံးပြုနိုင်ပါသည် (လက်ရှိအချိန်ကို `session_status` မှတဆင့် ရရှိနိုင်ပါသည်)။

## မက်ဆေ့ချ် စာအိတ်များ (မူလအားဖြင့် local)

ဝင်လာသော မက်ဆေ့ချ်များကို အချိန်တံဆိပ် (မိနစ်အဆင့် တိကျမှု) ဖြင့် ထုပ်ပိုးထားသည်–

```
[Provider ... 2026-01-05 16:26 PST] message text
```

ဤစာအိတ် အချိန်တံဆိပ်သည် provider timezone မည်သို့ပင်ဖြစ်စေ **မူလအားဖြင့် ဟို့စ်အတွင်းရှိ ဒေသအချိန်** ကို အသုံးပြုသည်။

ဤအပြုအမူကို ပြောင်းလဲနိုင်သည်–

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` သည် UTC ကို အသုံးပြုသည်။
- `envelopeTimezone: "local"` သည် ဟို့စ် timezone ကို အသုံးပြုသည်။
- `envelopeTimezone: "user"` သည် `agents.defaults.userTimezone` ကို အသုံးပြုသည် (မရှိပါက ဟို့စ် timezone သို့ ပြန်လည်ကျဆင်းသည်)။
- သတ်မှတ်ထားသော ဇုန်အတွက် IANA timezone ကို တိတိကျကျ သတ်မှတ်နိုင်သည် (ဥပမာ `"America/Chicago"`)။
- `envelopeTimestamp: "off"` သည် စာအိတ် header များမှ absolute timestamps ကို ဖယ်ရှားသည်။
- `envelopeElapsed: "off"` သည် elapsed time suffix များ ( `+2m` စတိုင်) ကို ဖယ်ရှားသည်။

### ဥပမာများ

**Local (မူလ):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**အသုံးပြုသူ timezone:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Elapsed time ဖွင့်ထားသည်:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## စနစ် prompt: လက်ရှိ ရက်စွဲ & အချိန်

အသုံးပြုသူ၏ timezone ကို သိရှိထားပါက၊ စနစ် prompt တွင်
prompt caching ကို တည်ငြိမ်စေရန် **အချိန်ဇုန်သာ** (နာရီ/အချိန် ဖော်မတ် မပါ)
ပါဝင်သော **Current Date & Time** အပိုင်းကို ထည့်သွင်းပေးသည်–

```
Time zone: America/Chicago
```

အေးဂျင့်အနေဖြင့် လက်ရှိအချိန်ကို လိုအပ်ပါက `session_status` tool ကို အသုံးပြုပါ။
status ကတ်တွင် အချိန်တံဆိပ် စာကြောင်းတစ်ကြောင်း ပါဝင်သည်။

## စနစ်ဖြစ်ရပ် စာကြောင်းများ (မူလအားဖြင့် local)

အေးဂျင့် context အတွင်း ထည့်သွင်းထားသော queued system events များကို
မက်ဆေ့ချ် စာအိတ်များနှင့် တူညီသော timezone ရွေးချယ်မှုဖြင့်
အချိန်တံဆိပ် တစ်ခုကို အရှေ့တွင် ထည့်ထားသည် (မူလ: ဟို့စ်အတွင်းရှိ ဒေသအချိန်)။

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### အသုံးပြုသူ timezone + ဖော်မတ် ပြင်ဆင်ခြင်း

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` သည် prompt context အတွက် **အသုံးပြုသူ ဒေသအချိန်ဇုန်** ကို သတ်မှတ်သည်။
- `timeFormat` သည် prompt အတွင်းရှိ **12h/24h ပြသပုံ** ကို ထိန်းချုပ်ပါသည်။ `auto` သည် OS preference ကို လိုက်နာပါသည်။

## အချိန်ဖော်မတ် ခန့်မှန်းသိရှိခြင်း (အလိုအလျောက်)

`timeFormat: "auto"` ဖြစ်ပါက OpenClaw သည် OS preference (macOS/Windows) ကို စစ်ဆေးပြီး locale formatting သို့ ပြန်လည်ကျဆင်းအသုံးပြုပါသည်။ စစ်ဆေးတွေ့ရှိသော တန်ဖိုးကို **process တစ်ခုလျှင် cache လုပ်ထား** သောကြောင့် system call များကို ထပ်ခါတလဲလဲ မခေါ်ရပါ။

## Tool payload များ + connectors (provider မူရင်းအချိန် + ပုံမှန်ပြုလုပ်ထားသော fields)

Channel tools များသည် **provider မူရင်း အချိန်တံဆိပ်များ** ကို ပြန်ပေးပြီး
ကိုက်ညီမှုရှိစေရန် ပုံမှန်ပြုလုပ်ထားသော fields များကို ထပ်မံ ထည့်သွင်းပေးသည်–

- `timestampMs`: epoch milliseconds (UTC)
- `timestampUtc`: ISO 8601 UTC စာကြောင်း

Raw provider fields များကို ထိန်းသိမ်းထားသောကြောင့် အချက်အလက် မည်သည့်အရာမျှ မပျောက်ဆုံးပါ။

- Slack: API မှ ရရှိသော epoch ဆန်သော စာကြောင်းများ
- Discord: UTC ISO အချိန်တံဆိပ်များ
- Telegram/WhatsApp: provider အလိုက် သီးသန့် numeric/ISO အချိန်တံဆိပ်များ

Local time ကို လိုအပ်ပါက သိရှိထားသော timezone ကို အသုံးပြု၍ downstream တွင် ပြောင်းလဲပါ။

## ဆက်စပ် စာရွက်စာတမ်းများ

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
