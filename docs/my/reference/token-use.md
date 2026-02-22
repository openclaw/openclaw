---
summary: "OpenClaw သည် prompt context ကို မည်သို့ တည်ဆောက်ပြီး token အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များကို မည်သို့ အစီရင်ခံကြောင်း"
read_when:
  - Token အသုံးပြုမှု၊ ကုန်ကျစရိတ်များ သို့မဟုတ် context window များကို ရှင်းပြရာတွင်
  - Context တိုးပွားမှု သို့မဟုတ် ချုံ့သိမ်းမှု အပြုအမူကို debug လုပ်ရာတွင်
title: "Token အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များ"
---

# Token အသုံးပြုမှုနှင့် ကုန်ကျစရိတ်များ

39. OpenClaw က characters မဟုတ်ဘဲ **tokens** ကို ခြေရာခံပါတယ်။ 40. Tokens တွေက model အလိုက် ကွဲပြားပေမဲ့၊ များသောအားဖြင့်
    OpenAI-style models တွေအတွက် အင်္ဂလိပ်စာသားမှာ token တစ်ခုလျှင် အက္ခရာ ~4 လောက် ပျမ်းမျှ ရှိပါတယ်။

## System prompt ကို မည်သို့ တည်ဆောက်သနည်း

41. OpenClaw က chạy လုပ်တိုင်း system prompt ကို ကိုယ်တိုင် စုစည်းပါတယ်။ 42. အဲဒါမှာ ပါဝင်တာတွေက:

- Tool စာရင်းနှင့် အတိုချုံးဖော်ပြချက်များ
- Skills စာရင်း (metadata သာ ပါဝင်ပြီး ညွှန်ကြားချက်များကို `read` ဖြင့် လိုအပ်သည့်အချိန်မှသာ load လုပ်သည်)
- Self-update ညွှန်ကြားချက်များ
- 43. Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, အသစ်ဖြစ်ရင် `BOOTSTRAP.md`)။ 44. ဖိုင်ကြီးတွေကို `agents.defaults.bootstrapMaxChars` (default: 20000) နဲ့ ဖြတ်တောက်ပါတယ်။
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

45. လက်တွေ့ကျတဲ့ ခွဲခြမ်းစိတ်ဖြာမှုအတွက် (ထည့်သွင်းထားတဲ့ ဖိုင်တစ်ခုချင်းစီ၊ tools, skills နဲ့ system prompt size အလိုက်) `/context list` သို့မဟုတ် `/context detail` ကို သုံးပါ။ 46. [Context](/concepts/context) ကို ကြည့်ပါ။

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

47. ဒီစျေးနှုန်းတွေက `input`, `output`, `cacheRead`, နဲ့
    `cacheWrite` အတွက် **token 1M လျှင် USD** ဖြစ်ပါတယ်။ 48. စျေးနှုန်း မရှိရင် OpenClaw က tokens ပမာဏပဲ ပြပါတယ်။ 49. OAuth tokens တွေမှာ
    ဒေါ်လာကုန်ကျစရိတ်ကို မပြပါဘူး။

## Cache TTL နှင့် pruning သက်ရောက်မှု

50. Provider prompt caching က cache TTL အချိန်အတွင်းမှာသာ အသုံးချနိုင်ပါတယ်။ OpenClaw can
    optionally run **cache-ttl pruning**: it prunes the session once the cache TTL
    has expired, then resets the cache window so subsequent requests can re-use the
    freshly cached context instead of re-caching the full history. This keeps cache
    write costs lower when a session goes idle past the TTL.

[Gateway configuration](/gateway/configuration) တွင် ပြင်ဆင်နိုင်ပြီး၊ အပြုအမူ အသေးစိတ်ကို [Session pruning](/concepts/session-pruning) တွင် ကြည့်ရှုပါ။

Heartbeat can keep the cache **warm** across idle gaps. If your model cache TTL
is `1h`, setting the heartbeat interval just under that (e.g., `55m`) can avoid
re-caching the full prompt, reducing cache write costs.

For Anthropic API pricing, cache reads are significantly cheaper than input
tokens, while cache writes are billed at a higher multiplier. See Anthropic’s
prompt caching pricing for the latest rates and TTL multipliers:
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
