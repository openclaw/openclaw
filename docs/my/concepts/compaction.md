---
summary: "Context window + compaction: OpenClaw သည် ဆက်ရှင်များကို မော်ဒယ်ကန့်သတ်ချက်များအောက်တွင် မည်သို့ ထိန်းထားသနည်း"
read_when:
  - Auto-compaction နှင့် /compact ကို နားလည်လိုသည့်အခါ
  - Context ကန့်သတ်ချက်များကို ထိမိနေသော ဆက်ရှင်ရှည်များကို စစ်ဆေးပြုပြင်နေသောအခါ
title: "Compaction"
---

# Context Window & Compaction

Model တစ်ခုချင်းစီတွင် **context window** (မြင်နိုင်သော max token အရေအတွက်) ရှိပါသည်။ ကြာရှည်သည့် chat များတွင် message နှင့် tool result များ စုပေါင်းလာပါသည်၊ window က တင်းကျပ်လာသောအခါ OpenClaw သည် limit အတွင်း ရှိစေရန် အဟောင်း history များကို **compact** လုပ်ပါသည်။

## Compaction ဆိုသည်မှာ

Compaction သည် **အဟောင်း conversation များကို summary လုပ်**၍ compact summary entry တစ်ခုအဖြစ် ထားပြီး လတ်တလော message များကို မပြောင်းလဲဘဲ ထိန်းထားပါသည်။ 1. အကျဉ်းချုပ်ကို session history ထဲမှာ သိမ်းဆည်းထားပြီး၊ နောက်ထပ် တောင်းဆိုမှုများတွင် အသုံးပြုသည်။

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

2. Compaction မလုပ်မီ၊ OpenClaw သည် **silent memory flush** turn ကို လုပ်ဆောင်ပြီး durable notes များကို disk သို့ သိမ်းဆည်းနိုင်သည်။ 3. အသေးစိတ်နှင့် config အတွက် [Memory](/concepts/memory) ကို ကြည့်ပါ။

## Manual compaction

Compaction ကို အတင်းအကျပ် လုပ်ဆောင်ရန် (ညွှန်ကြားချက်များကို ရွေးချယ်စွာ ထည့်သွင်းနိုင်ပါသည်) `/compact` ကို အသုံးပြုပါ—

```
/compact Focus on decisions and open questions
```

## Context window အရင်းအမြစ်

4. Context window သည် model အလိုက် ကွာခြားပါသည်။ 5. OpenClaw သည် ကန့်သတ်ချက်များကို သတ်မှတ်ရန် configured provider catalog ထဲမှ model definition ကို အသုံးပြုပါသည်။

## Compaction နှင့် pruning ၏ ကွာခြားချက်

- **Compaction**: အကျဉ်းချုပ်ဖော်ပြပြီး JSONL အတွင်း **အမြဲတမ်း သိမ်းဆည်း** ပါသည်။
- **Session pruning**: **tool ရလဒ်ဟောင်းများ** ကိုသာ **in-memory** အနေဖြင့် တောင်းဆိုမှုတစ်ခုချင်းစီအလိုက် ဖြတ်တောက်ပါသည်။

Pruning အကြောင်း အသေးစိတ်ကို [/concepts/session-pruning](/concepts/session-pruning) တွင် ကြည့်ပါ။

## အကြံပြုချက်များ

- ဆက်ရှင်များဟာ အသစ်မခံစားရတော့ဘဲ context ပြည့်နှက်လာသည်ဟု ခံစားရပါက `/compact` ကို အသုံးပြုပါ။
- tool output ကြီးမားများကို မူလအားဖြင့် ဖြတ်တောက်ထားပြီးသားဖြစ်ပါသည်၊ pruning ဖြင့် tool-result စုပုံလာမှုကို ထပ်မံလျှော့ချနိုင်ပါသည်။
- အသစ်စက်စက် စတင်လိုပါက `/new` သို့မဟုတ် `/reset` ဖြင့် session id အသစ်တစ်ခုကို စတင်နိုင်ပါသည်။
