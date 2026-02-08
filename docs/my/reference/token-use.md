---
summary: "OpenClaw သည် prompt context ကို မည်သို့ တည်ဆောက်ပြီး token အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များကို မည်သို့ အစီရင်ခံကြောင်း"
read_when:
  - Token အသုံးပြုမှု၊ ကုန်ကျစရိတ်များ သို့မဟုတ် context window များကို ရှင်းပြရာတွင်
  - Context တိုးပွားမှု သို့မဟုတ် ချုံ့သိမ်းမှု အပြုအမူကို debug လုပ်ရာတွင်
title: "Token အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များ"
x-i18n:
  source_path: reference/token-use.md
  source_hash: f8bfadb36b51830c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:07Z
---

# Token အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များ

OpenClaw သည် **အက္ခရာအရေအတွက်** မဟုတ်ဘဲ **token များ** ကို ခြေရာခံသည်။ Token များသည် မော်ဒယ်အလိုက် ကွဲပြားသော်လည်း OpenAI ပုံစံ မော်ဒယ်များတွင် အင်္ဂလိပ်စာသားအတွက် ပျမ်းမျှ token တစ်ခုလျှင် အက္ခရာ ~4 လုံးခန့် ရှိသည်။

## System prompt ကို မည်သို့ တည်ဆောက်သနည်း

OpenClaw သည် run တစ်ကြိမ်စီတိုင်းတွင် ကိုယ်ပိုင် system prompt ကို စုစည်းတည်ဆောက်သည်။ ထိုအထဲတွင် ပါဝင်သည့် အချက်များမှာ—

- Tool စာရင်းနှင့် အတိုချုံးဖော်ပြချက်များ
- Skills စာရင်း (metadata သာ ပါဝင်ပြီး ညွှန်ကြားချက်များကို `read` ဖြင့် လိုအပ်သည့်အချိန်မှသာ load လုပ်သည်)
- Self-update ညွှန်ကြားချက်များ
- Workspace နှင့် bootstrap ဖိုင်များ (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` ကို အသစ်ဖြစ်လာသည့်အခါ). ဖိုင်အရွယ်အစားကြီးများကို `agents.defaults.bootstrapMaxChars` (မူလတန်ဖိုး: 20000) ဖြင့် ဖြတ်တောက်ထားသည်။
- အချိန် (UTC + အသုံးပြုသူ၏ timezone)
- Reply tag များနှင့် heartbeat အပြုအမူ
- Runtime metadata (ဟို့စ်/OS/မော်ဒယ်/စဉ်းစားမှု)

အသေးစိတ် ခွဲခြမ်းချက်အပြည့်အစုံကို [System Prompt](/concepts/system-prompt) တွင် ကြည့်ပါ။

## Context window အတွင်း တွက်ချက်ပါဝင်သည့် အရာများ

မော်ဒယ်ထံ ပို့သည့် အရာအားလုံးသည် context limit ထဲသို့ တွက်ချက်ဝင်ရောက်သည်—

- System prompt (အထက်တွင် ဖော်ပြထားသည့် အပိုင်းများအားလုံး)
- စကားပြော မှတ်တမ်း (user + assistant မက်ဆေ့ချ်များ)
- Tool call များနှင့် tool ရလဒ်များ
- Attachment/Transcript များ (ပုံများ၊ အသံ၊ ဖိုင်များ)
- Compaction summary များနှင့် pruning artifact များ
- Provider wrapper များ သို့မဟုတ် safety header များ (မြင်မရသော်လည်း တွက်ချက်ပါဝင်သည်)

လက်တွေ့အသုံးချ ခွဲခြမ်းချက်အတွက် (inject လုပ်ထားသော ဖိုင်တစ်ခုချင်းစီ၊ tool များ၊ skills များ၊ system prompt အရွယ်အစားအလိုက်) `/context list` သို့မဟုတ် `/context detail` ကို အသုံးပြုပါ။ [Context](/concepts/context) ကိုလည်း ကြည့်ရှုပါ။

## လက်ရှိ token အသုံးပြုမှုကို မည်သို့ ကြည့်ရှုရမည်နည်း

Chat အတွင်းတွင် အောက်ပါအရာများကို အသုံးပြုနိုင်သည်—

- `/status` → ဆက်ရှင် မော်ဒယ်၊ context အသုံးပြုမှု၊ နောက်ဆုံး response ၏ input/output token များနှင့် **ခန့်မှန်း ကုန်ကျစရိတ်** (API key အသုံးပြုသည့်အခါသာ) ကို ပြသသော **emoji ပါသော status card**
- `/usage off|tokens|full` → reply တစ်ခုချင်းစီ၏ အောက်ခြေတွင် **per-response usage footer** ကို ထည့်ပေးသည်။
  - ဆက်ရှင်တစ်ခုလုံးအတွက် ဆက်လက်တည်ရှိသည် (`responseUsage` အဖြစ် သိမ်းဆည်းထားသည်)။
  - OAuth auth အသုံးပြုသည့်အခါ **ကုန်ကျစရိတ်ကို ဖုံးကွယ်ထားသည်** (token များသာ ပြသသည်)။
- `/usage cost` → OpenClaw session log များမှ local ကုန်ကျစရိတ် အကျဉ်းချုပ်ကို ပြသည်။

အခြား မျက်နှာပြင်များ—

- **TUI/Web TUI:** `/status` နှင့် `/usage` ကို ပံ့ပိုးထားသည်။
- **CLI:** `openclaw status --usage` နှင့် `openclaw channels list` သည် provider quota window များကို ပြသသည် (per-response ကုန်ကျစရိတ် မဟုတ်ပါ)။

## ကုန်ကျစရိတ် ခန့်မှန်းချက် (ပြသသည့်အခါ)

ကုန်ကျစရိတ်များကို သင့်မော်ဒယ် pricing config အပေါ် အခြေခံ၍ ခန့်မှန်းထားသည်—

```
models.providers.<provider>.models[].cost
```

ဤတန်ဖိုးများသည် `input`, `output`, `cacheRead`, နှင့်
`cacheWrite` အတွက် **token ၁ သန်းလျှင် USD** ဖြစ်သည်။ Pricing မရှိပါက OpenClaw သည် token အရေအတွက်သာ ပြသမည်ဖြစ်သည်။ OAuth token များတွင် ဒေါ်လာ ကုန်ကျစရိတ်ကို မည်သည့်အခါမျှ မပြသပါ။

## Cache TTL နှင့် pruning သက်ရောက်မှု

Provider ၏ prompt caching သည် cache TTL window အတွင်းတွင်သာ သက်ရောက်သည်။ OpenClaw သည် ရွေးချယ်စရာအဖြစ် **cache-ttl pruning** ကို လုပ်ဆောင်နိုင်သည်—cache TTL ကုန်ဆုံးသည့်အခါ session ကို pruning လုပ်ပြီး၊ ထို့နောက် cache window ကို ပြန်လည်သတ်မှတ်ကာ နောက်ထပ် request များတွင် history အပြည့်ကို ထပ်မံ cache မလုပ်ဘဲ အသစ်ပြန်လည် cache လုပ်ထားသော context ကို ပြန်အသုံးချနိုင်စေသည်။ ၎င်းသည် session တစ်ခု TTL ကျော်လွန်၍ အလုပ်မလုပ်ဘဲ နားနေသောအခါ cache write ကုန်ကျစရိတ်ကို လျော့နည်းစေသည်။

[Gateway configuration](/gateway/configuration) တွင် ပြင်ဆင်နိုင်ပြီး၊ အပြုအမူ အသေးစိတ်ကို [Session pruning](/concepts/session-pruning) တွင် ကြည့်ရှုပါ။

Heartbeat သည် idle gap များအတွင်း cache ကို **နွေးထွေးစွာ ထိန်းထား** နိုင်သည်။ သင့်မော်ဒယ် cache TTL သည် `1h` ဖြစ်ပါက heartbeat interval ကို ထိုတန်ဖိုးထက် အနည်းငယ် နည်းအောင် (ဥပမာ `55m`) သတ်မှတ်ခြင်းဖြင့် prompt အပြည့်အစုံကို ထပ်မံ cache မလုပ်ရဘဲ cache write ကုန်ကျစရိတ်ကို လျော့ချနိုင်သည်။

Anthropic API pricing အရ cache read များသည် input token များထက် အလွန်စျေးသက်သာပြီး cache write များကို ပိုမြင့်သော multiplier ဖြင့် ချီးမြှောက်တွက်ချက်သည်။ နောက်ဆုံးနှုန်းထားများနှင့် TTL multiplier များအတွက် Anthropic ၏ prompt caching pricing ကို ကြည့်ပါ—
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### ဥပမာ: heartbeat ဖြင့် 1h cache ကို နွေးထွေးစွာ ထိန်းထားခြင်း

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Token ဖိအားကို လျော့ချရန် အကြံပြုချက်များ

- Session ရှည်လျားလာသောအခါ `/compact` ကို အသုံးပြုပြီး အကျဉ်းချုပ် ပြုလုပ်ပါ။
- Workflow များတွင် tool output ကြီးများကို ဖြတ်တောက်ပါ။
- Skill ဖော်ပြချက်များကို တိုတောင်းအောင် ထားပါ (skill စာရင်းကို prompt ထဲသို့ inject လုပ်ထားသည်)။
- စကားပြောများပြီး စူးစမ်းလေ့လာမှုအတွက် မော်ဒယ်အသေးများကို ဦးစားပေး အသုံးပြုပါ။

Skill စာရင်း overhead ကို မည်သို့တွက်ချက်ကြောင်း အတိအကျ သိရန် [Skills](/tools/skills) ကို ကြည့်ပါ။
