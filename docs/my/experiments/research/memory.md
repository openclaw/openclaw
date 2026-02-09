---
summary: "သုတေသန မှတ်စုများ — Clawd workspace များအတွက် offline memory စနစ် (Markdown ကို အမှန်တရားအရင်းအမြစ်အဖြစ်ထားပြီး index ကို ထုတ်လုပ်ခြင်း)"
read_when:
  - နေ့စဉ် Markdown လော့ဂ်များကို ကျော်လွန်သည့် workspace memory (~/.openclaw/workspace) ကို ဒီဇိုင်းဆွဲနေချိန်
  - Deciding: အချိန်ကန့်သတ်ချက်များ (“Nov 2025 အတွင်း ဘာတွေ မှန်ခဲ့သလဲ?”)
  - offline recall + reflection (retain/recall/reflect) ထည့်သွင်းနေချိန်
title: "Workspace Memory သုတေသန"
---

# Workspace Memory v2 (offline): သုတေသန မှတ်စုများ

Target: Clawd ပုံစံ workspace (`agents.defaults.workspace`, default `~/.openclaw/workspace`) တွင် “memory” ကို နေ့စဉ် Markdown ဖိုင်တစ်ဖိုင်စီ (`memory/YYYY-MM-DD.md`) နှင့် တည်ငြိမ်သော ဖိုင်အချို့ (ဥပမာ `memory.md`, `SOUL.md`) အဖြစ် သိမ်းဆည်းထားခြင်း။

ဤစာတမ်းသည် Markdown ကို အမြဲတမ်း စစ်ဆေးပြန်လည်ကြည့်ရှုနိုင်သော အမှန်တရားအရင်းအမြစ်အဖြစ် ထားရှိပြီး၊ ထုတ်လုပ်ထားသော index မှတစ်ဆင့် **ဖွဲ့စည်းထားသော recall** (ရှာဖွေမှု၊ entity အကျဉ်းချုပ်များ၊ ယုံကြည်မှု အပ်ဒိတ်များ) ကို ထပ်တိုးပေးသည့် **offline-first** memory ဖွဲ့စည်းပုံကို အဆိုပြုထားသည်။

## ဘာကြောင့် ပြောင်းလဲရမလဲ?

လက်ရှိ စနစ် (နေ့စဉ် ဖိုင်တစ်ဖိုင်) သည် အောက်ပါအတွက် အလွန်ကောင်းမွန်သည် —

- “append-only” ဂျာနယ်ရေးသားခြင်း
- လူသားက တိုက်ရိုက် ပြင်ဆင်ရေးသားနိုင်မှု
- git အခြေပြု တည်တံ့မှု + စစ်ဆေးနိုင်မှု
- အလွန်လွယ်ကူသော မှတ်တမ်းယူခြင်း (“ရေးထားလိုက်ရုံပဲ”)

သို့သော် အောက်ပါအတွက် အားနည်းသည် —

- အမြင့်မားသော recall ရယူမှု (“X အကြောင်း ဘာဆုံးဖြတ်ခဲ့လဲ?”, “Y ကို နောက်ဆုံး ဘယ်အချိန် စမ်းသပ်ခဲ့လဲ?”)
- entity အလယ်ပြု အဖြေများ (“Alice / The Castle / warelay အကြောင်း ပြောပါ”) ကို ဖိုင်များစွာ မပြန်ဖတ်ဘဲ မရနိုင်ခြင်း
- အမြင်/ဦးစားပေးချက် တည်ငြိမ်မှု (ပြောင်းလဲသည့်အခါ အထောက်အထား ပါရှိမှု)
- နှင့် conflict resolution **Daily log သည် daily log အတိုင်းပဲ ဖြစ်ရမည်**။

## ဒီဇိုင်း ရည်မှန်းချက်များ

- **Offline**: ကွန်ယက်မလိုအပ်ဘဲ လက်ပ်တပ်/Castle တွင် လည်ပတ်နိုင်ရမည်၊ cloud အပေါ် မမှီခိုရ။
- **ရှင်းလင်းဖော်ပြနိုင်မှု**: ပြန်လည်ရယူထားသော အရာများကို အရင်းအမြစ် (ဖိုင် + တည်နေရာ) ဖြင့် သက်သေပြနိုင်ပြီး inference နှင့် ခွဲခြားနိုင်ရမည်။
- **လုပ်ငန်းစဉ် ရိုးရှင်းမှု**: နေ့စဉ် မှတ်တမ်းရေးသားမှုသည် Markdown အဖြစ် ဆက်လက်ရှိရမည်၊ အလွန်အကျွံ schema မလိုအပ်။
- **အဆင့်လိုက် တိုးတက်နိုင်မှု**: v1 တွင် FTS သာဖြင့် အသုံးဝင်ရမည်၊ semantic/vector နှင့် graph များသည် optional upgrade ဖြစ်ရမည်။
- **Agent-friendly**: token budget အတွင်း “recall” လုပ်ရန် လွယ်ကူစေသည် (အချက်အလက် အစုအဝေး အသေးများကို ပြန်ပေးနိုင်ရန်)။

## North star မော်ဒယ် (Hindsight × Letta)

ပေါင်းစည်းရမည့် အစိတ်အပိုင်း နှစ်ခု —

1. **Letta/MemGPT ပုံစံ control loop**

- အမြဲ context ထဲတွင် ပါရှိရမည့် “core” သေးငယ်တစ်ခု (persona + အသုံးပြုသူ၏ အဓိက အချက်အလက်များ)
- အခြား အရာအားလုံးကို context အပြင်ဘက်တွင် ထားပြီး tool များမှတစ်ဆင့် ပြန်လည်ရယူခြင်း
- memory ရေးသားမှုများကို tool call အဖြစ် ထင်ရှားစွာ လုပ်ဆောင်ခြင်း (append/replace/insert)၊ သိမ်းဆည်းပြီး နောက်ထပ် turn တွင် ပြန်ထည့်သွင်းခြင်း

2. **Hindsight ပုံစံ memory substrate**

- မြင်တွေ့ထားသည်/ယုံကြည်ထားသည်/အကျဉ်းချုပ်ထားသည် ကို ခွဲခြားထားခြင်း
- retain/recall/reflect ကို ထောက်ပံ့ခြင်း
- အထောက်အထားနှင့်အတူ ပြောင်းလဲတိုးတက်နိုင်သော ယုံကြည်မှုပါရှိသည့် အမြင်များ
- entity သိမြင်မှုပါရှိသည့် retrieval + အချိန်ဆိုင်ရာ query များ (အပြည့်အဝ knowledge graph မရှိသော်လည်း)

## အဆိုပြုထားသော ဖွဲ့စည်းပုံ (Markdown ကို အမှန်တရားအရင်းအမြစ် + derived index)

### Canonical store (git-friendly)

`~/.openclaw/workspace` ကို လူသားဖတ်ရှုနိုင်သော canonical memory အဖြစ် ထားရှိပါ။

အကြံပြုထားသော workspace layout —

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

မှတ်ချက်များ —

- JSON အဖြစ် ပြောင်းရန် မလိုအပ်ပါ။ **အမြင်**: “Peter က ဘာကို ကြိုက်နှစ်သက်သလဲ?”
- `bank/` ဖိုင်များသည် reflection job များမှ **curate** လုပ်ထားသော အရာများဖြစ်ပြီး လက်ဖြင့် ပြင်ဆင်ရေးသားနိုင်ပါသေးသည်။
- `memory.md` သည် “သေးငယ် + core ဆန်” အဖြစ် ဆက်လက်ရှိရမည် — session တိုင်းတွင် Clawd က မြင်စေချင်သော အရာများ။

### Derived store (machine recall)

workspace အောက်တွင် derived index တစ်ခု ထည့်ပါ (git track မလုပ်လည်း ရပါသည်) —

```
~/.openclaw/workspace/.memory/index.sqlite
```

အောက်ပါအရာများဖြင့် backing လုပ်ပါ —

- facts + entity links + opinion metadata အတွက် SQLite schema
- lexical recall အတွက် SQLite **FTS5** (မြန်၊ သေးငယ်၊ offline)
- semantic recall အတွက် optional embeddings table (offline ဖြစ်နေဆဲ)

ဤ index သည် **Markdown မှ အမြဲတမ်း ပြန်တည်ဆောက်နိုင်ရမည်**။

## Retain / Recall / Reflect (လုပ်ငန်းလည်ပတ်မှု loop)

### Retain: နေ့စဉ် လော့ဂ်များကို “facts” အဖြစ် ပုံမှန်ပြုလုပ်ခြင်း

ဤနေရာတွင် အရေးပါသော Hindsight ၏ အဓိက အမြင် — **အကြောင်းအရာပြည့်စုံသော၊ ကိုယ်တိုင်ရပ်တည်နိုင်သော facts** ကို သိမ်းဆည်းပါ၊ အလွန်သေးငယ်သော snippet များ မဟုတ်ပါ။

`memory/YYYY-MM-DD.md` အတွက် လက်တွေ့စည်းမျဉ်း —

- နေ့ဆုံး (သို့) နေ့အတွင်း `## Retain` အပိုင်းတစ်ခု ထည့်ပြီး bullet ၂–၅ ခု ရေးပါ —
  - အကြောင်းအရာပါဝင်မှုရှိရမည် (cross-turn context ကို ထိန်းသိမ်းထား)
  - ကိုယ်တိုင်ရပ်တည်နိုင်ရမည် (နောက်မှ တစ်ခုတည်း ဖတ်လည်း နားလည်ရ)
  - type + entity mentions ဖြင့် tag လုပ်ထားရမည်

ဥပမာ —

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

အနည်းဆုံး parsing —

- Type prefix: `W` (world), `B` (experience/biographical), `O` (opinion), `S` (observation/summary; များသောအားဖြင့် generated)
- Entities: `@Peter`, `@warelay` စသည် (slug များသည် `bank/entities/*.md` သို့ map လုပ်ထား)
- Opinion confidence: `O(c=0.0..1.0)` optional

ရေးသားသူများကို စဉ်းစားရခက်စေချင်မယ် မထင်ပါက reflect job သည် လော့ဂ်၏ အခြားအစိတ်အပိုင်းများမှ ဤ bullet များကို ခန့်မှန်းထုတ်ယူနိုင်ပါသည်။ သို့သော် ထင်ရှားသော `## Retain` အပိုင်း ရှိခြင်းက “အရည်အသွေး တိုးတက်စေသော လီဗာ” အလွယ်ဆုံး ဖြစ်သည်။

### Recall: derived index အပေါ် query များ

Recall သည် အောက်ပါအရာများကို ထောက်ပံ့သင့်သည် —

- **lexical**: “တိတိကျကျ စကားလုံး/အမည်/command များ ရှာရန်” (FTS5)
- **entity**: “X အကြောင်း ပြောပါ” (entity page များ + entity ချိတ်ဆက်ထားသော facts)
- **temporal**: “နိုဝင်ဘာ ၂၇ အနီးအနား ဘာဖြစ်ခဲ့လဲ” / “ပြီးခဲ့သည့် အပတ်မှ စပြီး”
- (ယုံကြည်မှု + အထောက်အထားဖြင့်) OpenClaw သည် model providers များအတွက် OAuth နှင့် API keys ကို ထောက်ပံ့ပါသည်။

ပြန်ပေးမည့် ပုံစံသည် agent-friendly ဖြစ်ပြီး အရင်းအမြစ်များကို ကိုးကားသင့်သည် —

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (source day သို့မဟုတ် ထုတ်ယူထားသော အချိန်အပိုင်းအခြား)
- `entities` (`["Peter","warelay"]`)
- `content` (narrative fact)
- `source` (`memory/2025-11-27.md#L12` စသည်)

### Reflect: တည်ငြိမ်သော စာမျက်နှာများ ထုတ်လုပ်ပြီး ယုံကြည်ချက်များကို အပ်ဒိတ်လုပ်ခြင်း

Reflection သည် အချိန်ဇယားအတိုင်း (နေ့စဉ် သို့မဟုတ် heartbeat `ultrathink`) လည်ပတ်သော job ဖြစ်ပြီး —

- မကြာသေးမီ facts များမှ `bank/entities/*.md` ကို အပ်ဒိတ်လုပ်ခြင်း (entity အကျဉ်းချုပ်များ)
- reinforcement/contradiction အပေါ် မူတည်၍ `bank/opinions.md` ယုံကြည်မှုကို အပ်ဒိတ်လုပ်ခြင်း
- optional အဖြစ် `memory.md` (“core ဆန်သော” တည်တံ့အချက်အလက်များ) အတွက် ပြင်ဆင်ချက် အကြံပြုခြင်း

Opinion evolution (ရိုးရှင်း၊ ရှင်းလင်းဖော်ပြနိုင်) —

- opinion တစ်ခုစီတွင် —
  - statement
  - confidence `c ∈ [0,1]`
  - last_updated
  - evidence links (ထောက်ခံ/ဆန့်ကျင် fact ID များ)
- facts အသစ်များ ဝင်လာသောအခါ —
  - entity overlap + similarity (ပထမ FTS, နောက်မှ embeddings) ဖြင့် candidate opinion များ ရှာဖွေခြင်း
  - confidence ကို အနည်းငယ်စီ ပြောင်းလဲခြင်း; အပြောင်းအလဲကြီးများအတွက် ပြင်းထန်သော ဆန့်ကျင်ချက် + ထပ်ခါထပ်ခါ အထောက်အထား လိုအပ်

## CLI ပေါင်းစည်းမှု: standalone vs နက်ရှိုင်းသော ပေါင်းစည်းမှု

အကြံပြုချက်: **OpenClaw အတွင်း နက်ရှိုင်းစွာ ပေါင်းစည်းပါ**, သို့သော် ခွဲထုတ်နိုင်သော core library ကို ထိန်းသိမ်းထားပါ။

### OpenClaw အတွင်း ပေါင်းစည်းရခြင်း၏ အကြောင်းရင်း

- OpenClaw သည် အောက်ပါအရာများကို ရှိပြီးသား သိရှိထားသည် —
  - workspace path (`agents.defaults.workspace`)
  - session model + heartbeats
  - logging + troubleshooting ပုံစံများ
- agent ကိုယ်တိုင် tool များကို ခေါ်သုံးစေချင်သည် —
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### ဘာကြောင့် library ကို ခွဲထားသင့်သေးလဲ?

- Gateway/runtime မပါဘဲ memory logic ကို စမ်းသပ်နိုင်ရန်
- အခြား context များ (local script များ၊ အနာဂတ် desktop app စသည်) တွင် ပြန်လည်အသုံးချနိုင်ရန်

ပုံသဏ္ဌာန် —
Memory tooling ကို သေးငယ်သော CLI + library အလွှာအဖြစ် ရည်ရွယ်ထားသော်လည်း၊ ယခုအဆင့်တွင် သုတေသနဆိုင်ရာသာ ဖြစ်သည်။

## “S-Collide” / SuCo: ဘယ်အချိန် သုံးသင့်သလဲ (သုတေသန)

“S-Collide” သည် **SuCo (Subspace Collision)** ကို ဆိုလိုပါက — ၎င်းသည် subspace များအတွင်း သင်ကြားထားသော/ဖွဲ့စည်းထားသော collision များကို အသုံးပြုပြီး recall/latency အချိုးအစားကောင်းများ ရရှိစေရန် ရည်ရွယ်သည့် ANN retrieval နည်းလမ်းတစ်ခု ဖြစ်သည် (paper: arXiv 2411.14754, 2024)။

`~/.openclaw/workspace` အတွက် လက်တွေ့မြင်ကွင်း —

- SuCo ကို **မစတင်ပါနှင့်**။
- SQLite FTS + (optional) ရိုးရှင်းသော embeddings ဖြင့် စတင်ပါ; UX အကျိုးကျေးဇူး အများစုကို ချက်ချင်း ရရှိပါမည်။
- အောက်ပါအခြေအနေများ ဖြစ်လာမှသာ SuCo/HNSW/ScaNN အမျိုးအစား ဖြေရှင်းချက်များကို စဉ်းစားပါ —
  - corpus အရွယ်အစား ကြီးလာသည် (သောင်းချီ/သိန်းချီ chunk များ)
  - brute-force embedding search သည် အလွန်နှေးလာသည်
  - lexical search ကြောင့် recall အရည်အသွေး အမှန်တကယ် ကန့်သတ်ခံနေရသည်

Offline-friendly အခြားရွေးချယ်စရာများ (ရှုပ်ထွေးမှု တိုးလာသည့် အစဉ်) —

- SQLite FTS5 + metadata filter များ (ML မလို)
- Embeddings + brute force (chunk အရေအတွက် နည်းလျှင် အံ့သြဖွယ်ကောင်းအောင် အလုပ်လုပ်နိုင်)
- HNSW index (အသုံးများ၊ တည်ငြိမ်; library binding လိုအပ်)
- SuCo (သုတေသနအဆင့်; embed လုပ်နိုင်သည့် အကောင်းဆုံး implementation ရှိပါက စိတ်ဝင်စားဖွယ်)

မေးခွန်း ဖွင့်ထားဆဲ —

- သင့်စက်များ (လက်ပ်တပ် + ဒက်စ်တော့) ပေါ်တွင် “personal assistant memory” အတွက် **အကောင်းဆုံး** offline embedding မော်ဒယ်က ဘာလဲ?
  - Ollama ရှိပြီးသား ဖြစ်ပါက local model ဖြင့် embed လုပ်ပါ; မရှိပါက toolchain အတွင်း သေးငယ်သော embedding မော်ဒယ်တစ်ခု ထည့်သွင်းပို့ဆောင်ပါ။

## အသုံးဝင်ဆုံး အနည်းဆုံး pilot

အနည်းဆုံး ဖြစ်သော်လည်း အသုံးဝင်စေရန် —

- `bank/` entity page များနှင့် နေ့စဉ် လော့ဂ်များအတွင်း `## Retain` အပိုင်းတစ်ခု ထည့်ပါ။
- citation (path + line number) ပါရှိသော recall အတွက် SQLite FTS ကို အသုံးပြုပါ။
- recall အရည်အသွေး သို့မဟုတ် အရွယ်အစား လိုအပ်ချက် မတိုးလာမချင်း embeddings မထည့်ပါနှင့်။

## ကိုးကားချက်များ

- Letta / MemGPT အယူအဆများ: “core memory blocks” + “archival memory” + tool အခြေပြု self-editing memory။
- Hindsight Technical Report: “retain / recall / reflect”, four-network memory, narrative fact extraction, opinion confidence evolution။
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” approximate nearest neighbor retrieval။
