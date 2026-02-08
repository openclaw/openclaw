---
title: ဖော်မယ်လ် အတည်ပြုခြင်း (လုံခြုံရေး မော်ဒယ်များ)
summary: OpenClaw ၏ အန္တရာယ်အမြင့်ဆုံး လမ်းကြောင်းများအတွက် စက်ဖြင့် စစ်ဆေးအတည်ပြုထားသော လုံခြုံရေး မော်ဒယ်များ။
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:18Z
---

# ဖော်မယ်လ် အတည်ပြုခြင်း (လုံခြုံရေး မော်ဒယ်များ)

ဤစာမျက်နှာသည် OpenClaw ၏ **ဖော်မယ်လ် လုံခြုံရေး မော်ဒယ်များ** ကို မှတ်တမ်းတင်ထားသည် (ယနေ့တွင် TLA+/TLC ကို အသုံးပြုထားပြီး လိုအပ်သလို ထပ်မံ တိုးချဲ့မည်)။

> မှတ်ချက်: အဟောင်းလင့်ခ်အချို့တွင် ယခင် ပရောဂျက်အမည်ကို ကိုးကားထားနိုင်သည်။

**ရည်မှန်းချက် (north star):** သတ်မှတ်ထားသော အယူအဆများအောက်တွင် OpenClaw သည် မိမိရည်ရွယ်ထားသော လုံခြုံရေး မူဝါဒ (အခွင့်ပြုချက်၊ ဆက်ရှင် ခွဲခြားထားမှု၊ ကိရိယာ ဂိတ်တံခါးချထားမှု၊ နှင့် မှားယွင်းစွာ ဖွဲ့စည်းထားမှုအပေါ် လုံခြုံရေး) ကို လိုက်နာကြောင်း စက်ဖြင့် စစ်ဆေးအတည်ပြုနိုင်သော အငြင်းအခုံတစ်ရပ် ပေးနိုင်ရန် ဖြစ်သည်။

**ဤအရာသည် (ယနေ့အနေဖြင့်):** အကောင်အထည်ဖော်၍ လည်ပတ်နိုင်သော၊ တိုက်ခိုက်သူအမြင်အခြေပြု **လုံခြုံရေး regression စမ်းသပ်မှုစု** ဖြစ်သည်—

- အဆိုတစ်ခုချင်းစီတွင် အကန့်အသတ်ရှိသော state space အပေါ် မော်ဒယ်စစ်ဆေးမှုကို လည်ပတ်နိုင်သည်။
- အဆိုအများစုတွင် အမှန်တကယ် ဖြစ်နိုင်သော bug အမျိုးအစားများအတွက် counterexample trace ကို ထုတ်ပေးသော **အနုတ်လက္ခဏာ မော်ဒယ်** တစ်ခုကို တွဲဖက်ထားသည်။

**ဤအရာမဟုတ်သေးသည် (ယခုအချိန်တွင်):** “OpenClaw သည် အရာအားလုံးအတွက် လုံခြုံသည်” ဟု သက်သေပြသည့် အထောက်အထားတစ်ရပ် သို့မဟုတ် TypeScript အကောင်အထည်ဖော်မှု အပြည့်အစုံ မှန်ကန်ကြောင်း အတည်ပြုချက် မဟုတ်ပါ။

## မော်ဒယ်များ တည်ရှိရာနေရာ

မော်ဒယ်များကို သီးခြား repo တစ်ခုတွင် ထိန်းသိမ်းထားသည် — [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)။

## အရေးကြီးသော သတိပြုရန်များ

- ဤအရာများသည် **မော်ဒယ်များ** ဖြစ်ပြီး TypeScript အကောင်အထည်ဖော်မှု အပြည့်အစုံ မဟုတ်ပါ။ မော်ဒယ်နှင့် ကုဒ်ကြား ကွာဟမှု ဖြစ်နိုင်သည်။
- ရလဒ်များသည် TLC မှ စူးစမ်းထားသော state space အကန့်အသတ်အတွင်းသာ အကျုံးဝင်သည်; “အစိမ်း” ဟု ပြသသည်မှာ မော်ဒယ်ထားသည့် အယူအဆများနှင့် ကန့်သတ်ချက်များကို ကျော်လွန်၍ လုံခြုံကြောင်း အဓိပ္ပာယ်မရှိပါ။
- အဆိုအချို့သည် ပတ်ဝန်းကျင်ဆိုင်ရာ အယူအဆများကို ထင်ရှားစွာ မှီခိုထားသည် (ဥပမာ၊ မှန်ကန်သော deployment၊ မှန်ကန်သော configuration ထည့်သွင်းမှုများ)။

## ရလဒ်များကို ပြန်လည်ထုတ်လုပ်ခြင်း

ယနေ့အနေဖြင့် ရလဒ်များကို မော်ဒယ် repo ကို လိုကယ်တွင် clone လုပ်ပြီး TLC ကို လည်ပတ်ခြင်းဖြင့် ပြန်လည်ထုတ်လုပ်သည် (အောက်တွင် ကြည့်ပါ)။ အနာဂတ်တွင် အောက်ပါအရာများကို ပံ့ပိုးနိုင်သည်—

- CI မှ မော်ဒယ်များကို လည်ပတ်ပြီး အများပြည်သူကြည့်ရှုနိုင်သော artifacts (counterexample traces၊ run logs) များ ပေးခြင်း
- အကန့်အသတ်ရှိသော စစ်ဆေးမှုအသေးများအတွက် “ဤမော်ဒယ်ကို လည်ပတ်ပါ” ဟုဆိုသည့် hosted workflow

စတင်အသုံးပြုရန်:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway ထိတွေ့မှုနှင့် open gateway မဖွဲ့စည်းမှုပြဿနာ

**အဆို:** auth မပါဘဲ loopback ကျော်လွန်၍ bind လုပ်ခြင်းသည် အဝေးမှ ထိခိုက်စေနိုင်ခြေကို ဖြစ်စေသည် / ထိတွေ့မှုကို တိုးစေသည်; token/password သည် မူဝါဒအယူအဆများအောက်တွင် auth မပါသော တိုက်ခိုက်သူများကို တားဆီးနိုင်သည်။

- အစိမ်းရလဒ်များ:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make gateway-exposure-v2-negative`

ထပ်မံကြည့်ရန်: မော်ဒယ် repo ထဲရှိ `docs/gateway-exposure-matrix.md`။

### Nodes.run pipeline (အန္တရာယ်အမြင့်ဆုံး စွမ်းရည်)

**အဆို:** `nodes.run` သည် (a) နိုဒ် အမိန့် allowlist နှင့် ကြေညာထားသော အမိန့်များ၊ (b) ဖွဲ့စည်းထားပါက live approval လိုအပ်သည်; approvals များကို replay မဖြစ်စေရန် tokenized လုပ်ထားသည် (မော်ဒယ်အတွင်း)။

- အစိမ်းရလဒ်များ:
  - `make nodes-pipeline`
  - `make approvals-token`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Pairing store (DM gating)

**အဆို:** pairing တောင်းဆိုမှုများသည် TTL နှင့် pending-request အကန့်အသတ်များကို လိုက်နာသည်။

- အစိမ်းရလဒ်များ:
  - `make pairing`
  - `make pairing-cap`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Ingress gating (mentions + control-command bypass)

**အဆို:** mention လိုအပ်သော အုပ်စုအခြေအနေများတွင် ခွင့်မပြုထားသော “control command” သည် mention gating ကို မကျော်လွှားနိုင်ပါ။

- အစိမ်း:
  - `make ingress-gating`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make ingress-gating-negative`

### Routing/session-key ခွဲခြားထားမှု

**အဆို:** မတူညီသော peer များမှ DM များသည် အထူးတလည် link သို့မဟုတ် configuration မလုပ်ထားပါက တစ်ခုတည်းသော session အဖြစ် မပေါင်းစည်းပါ။

- အစိမ်း:
  - `make routing-isolation`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make routing-isolation-negative`

## v1++: ထပ်မံသော အကန့်အသတ်ရှိ မော်ဒယ်များ (concurrency, retries, trace မှန်ကန်မှု)

ဤမော်ဒယ်များသည် အမှန်တကယ် ကမ္ဘာအခြေအနေများတွင် ဖြစ်တတ်သော မအတူတကွလုပ်ဆောင်သည့် update များ၊ retries နှင့် message fan-out များကို ပိုမိုတိကျစေရန် ဆက်လက်တိုးချဲ့ထားသည်။

### Pairing store concurrency / idempotency

**အဆို:** pairing store သည် interleavings ဖြစ်ပေါ်နေချိန်တွင်ပါ `MaxPending` နှင့် idempotency ကို လိုက်နာရမည် (ဆိုလိုသည်မှာ “check-then-write” သည် atomic ဖြစ်ရမည် သို့မဟုတ် lock လုပ်ထားရမည်; refresh လုပ်ခြင်းကြောင့် duplicate မဖြစ်သင့်)။

အဓိပ္ပာယ်မှာ—

- တစ်ပြိုင်နက် တောင်းဆိုမှုများအောက်တွင် channel တစ်ခုအတွက် `MaxPending` ကို မကျော်လွန်ရပါ။
- တူညီသော `(channel, sender)` အတွက် ထပ်ခါထပ်ခါ တောင်းဆိုခြင်း/refresh လုပ်ခြင်းသည် duplicate live pending rows မဖန်တီးသင့်ပါ။

- အစိမ်းရလဒ်များ:
  - `make pairing-race` (atomic/locked cap စစ်ဆေးမှု)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make pairing-race-negative` (non-atomic begin/commit cap race)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Ingress trace ဆက်စပ်မှု / idempotency

**အဆို:** ingestion သည် fan-out အတွင်း trace ဆက်စပ်မှုကို ထိန်းသိမ်းထားရမည်နှင့် provider retries အောက်တွင် idempotent ဖြစ်ရမည်။

အဓိပ္ပာယ်မှာ—

- အပြင်ဘက် ဖြစ်ရပ်တစ်ခုမှ အတွင်းပိုင်း မက်ဆေ့ချ်များ အများအပြား ဖြစ်လာသောအခါ အစိတ်အပိုင်းအားလုံးသည် တူညီသော trace/event identity ကို ထိန်းထားရမည်။
- Retries များကြောင့် double-processing မဖြစ်သင့်ပါ။
- Provider event IDs မရှိပါက distinct ဖြစ်ရပ်များကို မလွတ်သွားစေရန် dedupe သည် လုံခြုံသော ကီး (ဥပမာ၊ trace ID) သို့ ပြန်လည်အခြေခံရမည်။

- အစိမ်း:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Routing dmScope ဦးစားပေးမှု + identityLinks

**အဆို:** routing သည် ပုံမှန်အားဖြင့် DM session များကို ခွဲခြားထားရမည်ဖြစ်ပြီး၊ အထူးတလည် ဖွဲ့စည်းထားသောအခါသာ session များကို ပေါင်းစည်းရမည် (channel ဦးစားပေးမှု + identity links)။

အဓိပ္ပာယ်မှာ—

- Channel အလိုက် dmScope override များသည် global default များထက် ဦးစားပေးရမည်။
- identityLinks များသည် ဆက်စပ်ထားသော အုပ်စုများအတွင်းတွင်သာ collapse လုပ်ရမည်ဖြစ်ပြီး မဆိုင်သော peer များအကြား မဖြစ်သင့်ပါ။

- အစိမ်း:
  - `make routing-precedence`
  - `make routing-identitylinks`
- အနီ (မျှော်လင့်ထားသည့်အတိုင်း):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
