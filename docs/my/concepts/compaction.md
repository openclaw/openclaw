---
summary: "Context window + compaction: OpenClaw သည် ဆက်ရှင်များကို မော်ဒယ်ကန့်သတ်ချက်များအောက်တွင် မည်သို့ ထိန်းထားသနည်း"
read_when:
  - Auto-compaction နှင့် /compact ကို နားလည်လိုသည့်အခါ
  - Context ကန့်သတ်ချက်များကို ထိမိနေသော ဆက်ရှင်ရှည်များကို စစ်ဆေးပြုပြင်နေသောအခါ
title: "Compaction"
x-i18n:
  source_path: concepts/compaction.md
  source_hash: e1d6791f2902044b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:16Z
---

# Context Window & Compaction

မော်ဒယ်တိုင်းတွင် **context window** (မြင်နိုင်သော token အများဆုံးအရေအတွက်) ရှိပါသည်။ အချိန်ကြာရှည်စွာ ဆက်လက်ပြောဆိုသည့် ချတ်များတွင် မက်ဆေ့ချ်များနှင့် tool ရလဒ်များ စုဆောင်းလာပြီး window ကန့်သတ်ချက်နီးကပ်လာသောအခါ OpenClaw သည် ကန့်သတ်ချက်များအတွင်း ဆက်လက်လုပ်ဆောင်နိုင်ရန် အဟောင်းများကို **compaction** ပြုလုပ်ပါသည်။

## Compaction ဆိုသည်မှာ

Compaction သည် **အဟောင်းများသော စကားဝိုင်းကို အကျဉ်းချုပ်ဖော်ပြခြင်း** ပြုလုပ်ပြီး နောက်ဆုံးပိုင်း မက်ဆေ့ချ်များကို မပြောင်းလဲဘဲ ထားရှိပါသည်။ အကျဉ်းချုပ်ကို ဆက်ရှင်မှတ်တမ်းအတွင်း သိမ်းဆည်းထားသောကြောင့် နောက်တစ်ကြိမ် တောင်းဆိုမှုများတွင် အောက်ပါအချက်များကို အသုံးပြုပါသည်—

- Compaction အကျဉ်းချုပ်
- Compaction ပြုလုပ်ထားသည့် အချက်အလက်အပြီးရှိ မကြာသေးမီ မက်ဆေ့ချ်များ

Compaction သည် ဆက်ရှင်၏ JSONL မှတ်တမ်းအတွင်း **အမြဲတမ်း သိမ်းဆည်းထား** ပါသည်။

## Configuration

`agents.defaults.compaction` ဆိုင်ရာ ဆက်တင်များအတွက် [Compaction config & modes](/concepts/compaction) ကို ကြည့်ပါ။

## Auto-compaction (မူလအားဖြင့် ဖွင့်ထားသည်)

ဆက်ရှင်သည် မော်ဒယ်၏ context window ကို နီးကပ်လာပါက သို့မဟုတ် ကျော်လွန်ပါက OpenClaw သည် auto-compaction ကို စတင်လုပ်ဆောင်ပြီး compact ပြုလုပ်ထားသော context ကို အသုံးပြုကာ မူလတောင်းဆိုမှုကို ပြန်လည်ကြိုးစားနိုင်ပါသည်။

အောက်ပါအရာများကို တွေ့ရပါလိမ့်မည်—

- verbose mode တွင် `🧹 Auto-compaction complete`
- `🧹 Compactions: <count>` ကို ပြသထားသော `/status`

Compaction မပြုလုပ်မီ OpenClaw သည် disk တွင် တည်တံ့စွာ သိမ်းဆည်းရန်အတွက် **silent memory flush** အလှည့်ကို လုပ်ဆောင်နိုင်ပါသည်။ အသေးစိတ်နှင့် configuration အတွက် [Memory](/concepts/memory) ကို ကြည့်ပါ။

## Manual compaction

Compaction ကို အတင်းအကျပ် လုပ်ဆောင်ရန် (ညွှန်ကြားချက်များကို ရွေးချယ်စွာ ထည့်သွင်းနိုင်ပါသည်) `/compact` ကို အသုံးပြုပါ—

```
/compact Focus on decisions and open questions
```

## Context window အရင်းအမြစ်

Context window သည် မော်ဒယ်အလိုက် ကွဲပြားပါသည်။ OpenClaw သည် သတ်မှတ်ထားသော provider catalog ထဲရှိ မော်ဒယ် သတ်မှတ်ချက်ကို အသုံးပြုပြီး ကန့်သတ်ချက်များကို ဆုံးဖြတ်ပါသည်။

## Compaction နှင့် pruning ၏ ကွာခြားချက်

- **Compaction**: အကျဉ်းချုပ်ဖော်ပြပြီး JSONL အတွင်း **အမြဲတမ်း သိမ်းဆည်း** ပါသည်။
- **Session pruning**: **tool ရလဒ်ဟောင်းများ** ကိုသာ **in-memory** အနေဖြင့် တောင်းဆိုမှုတစ်ခုချင်းစီအလိုက် ဖြတ်တောက်ပါသည်။

Pruning အကြောင်း အသေးစိတ်ကို [/concepts/session-pruning](/concepts/session-pruning) တွင် ကြည့်ပါ။

## အကြံပြုချက်များ

- ဆက်ရှင်များဟာ အသစ်မခံစားရတော့ဘဲ context ပြည့်နှက်လာသည်ဟု ခံစားရပါက `/compact` ကို အသုံးပြုပါ။
- tool output ကြီးမားများကို မူလအားဖြင့် ဖြတ်တောက်ထားပြီးသားဖြစ်ပါသည်၊ pruning ဖြင့် tool-result စုပုံလာမှုကို ထပ်မံလျှော့ချနိုင်ပါသည်။
- အသစ်စက်စက် စတင်လိုပါက `/new` သို့မဟုတ် `/reset` ဖြင့် session id အသစ်တစ်ခုကို စတင်နိုင်ပါသည်။
