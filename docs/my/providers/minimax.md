---
summary: "OpenClaw တွင် MiniMax M2.1 ကို အသုံးပြုရန်"
read_when:
  - OpenClaw တွင် MiniMax မော်ဒယ်များကို အသုံးပြုလိုပါက
  - MiniMax တပ်ဆင်မှု လမ်းညွှန်ချက်များ လိုအပ်ပါက
title: "MiniMax"
---

# MiniMax

MiniMax သည် **M2/M2.1** model family ကို တည်ဆောက်သော AI ကုမ္ပဏီဖြစ်သည်။ လက်ရှိ coding ကို အဓိကထားသော release သည် **MiniMax M2.1** (December 23, 2025) ဖြစ်ပြီး လက်တွေ့ကမ္ဘာရှိ complex tasks များအတွက် တည်ဆောက်ထားသည်။

ရင်းမြစ်: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## မော်ဒယ် အကျဉ်းချုပ် (M2.1)

MiniMax မှ M2.1 တွင် အောက်ပါ တိုးတက်မှုများကို အလေးပေး ဖော်ပြထားပါသည်–

- **ဘာသာစကားစုံ ကုဒ်ရေးသားမှု** ပိုမိုအားကောင်းလာခြင်း (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS)။
- **ဝဘ်/အက်ပ် ဖွံ့ဖြိုးရေး** နှင့် အလှအပ ထုတ်လွှင့်မှု အရည်အသွေး ပိုမိုကောင်းမွန်လာခြင်း (native mobile အပါအဝင်)။
- ရုံးလုပ်ငန်းပုံစံ workflow များအတွက် **ပေါင်းစပ်ညွှန်ကြားချက်များ** ကို ကိုင်တွယ်နိုင်မှု တိုးတက်လာခြင်း၊
  interleaved thinking နှင့် integrated constraint execution အပေါ် အခြေခံထားသည်။
- token အသုံးပြုမှု နည်းပါးပြီး iteration loop ပိုမိုမြန်ဆန်သော **ပိုမိုအကျဉ်းချုပ်သော အဖြေများ**။
- **tool/agent framework** ကိုက်ညီမှုနှင့် context စီမံခန့်ခွဲမှု ပိုမိုအားကောင်းလာခြင်း (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox)။
- **ဆွေးနွေးရေးသားမှုနှင့် နည်းပညာစာရေးသားမှု** အရည်အသွေး ပိုမိုမြင့်မားလာခြင်း။

## MiniMax M2.1 နှင့် MiniMax M2.1 Lightning နှိုင်းယှဉ်ခြင်း

- **မြန်နှုန်း:** Lightning သည် MiniMax ၏ စျေးနှုန်း စာရွက်စာတမ်းများတွင် “မြန်ဆန်” ဗားရှင်းအဖြစ် ဖော်ပြထားသည်။
- **ကုန်ကျစရိတ်:** input ကုန်ကျစရိတ် တူညီသော်လည်း Lightning တွင် output ကုန်ကျစရိတ် ပိုမိုမြင့်မားသည်။
- **Coding plan routing:** MiniMax coding plan တွင် Lightning back-end ကို တိုက်ရိုက် အသုံးမပြုနိုင်ပါ။ MiniMax သည် requests အများစုကို Lightning သို့ auto-route လုပ်ပေးသော်လည်း traffic spike ဖြစ်သည့်အချိန်တွင် regular M2.1 back-end သို့ fallback လုပ်ပါသည်။

## တပ်ဆင်ပုံ ရွေးချယ်ခြင်း

### MiniMax OAuth (Coding Plan) — အကြံပြုထားသည်

**သင့်တော်သောအခြေအနေ:** OAuth ဖြင့် MiniMax Coding Plan ကို အသုံးပြုပြီး အမြန်တပ်ဆင်လိုပါက၊ API key မလိုအပ်ပါ။

bundled OAuth plugin ကို ဖွင့်ပြီး authentication ပြုလုပ်ပါ–

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

endpoint တစ်ခုကို ရွေးချယ်ရန် တောင်းဆိုပါလိမ့်မည်–

- **Global** - နိုင်ငံတကာ အသုံးပြုသူများ (`api.minimax.io`)
- **CN** - တရုတ်ပြည်ရှိ အသုံးပြုသူများ (`api.minimaxi.com`)

အသေးစိတ်အတွက် [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) ကို ကြည့်ပါ။

### MiniMax M2.1 (API key)

**သင့်တော်သောအခြေအနေ:** Anthropic-compatible API ဖြင့် hosted MiniMax ကို အသုံးပြုလိုပါက။

CLI မှတစ်ဆင့် ဖွဲ့စည်းပြင်ဆင်ပါ–

- `openclaw configure` ကို လုပ်ဆောင်ပါ
- **Model/auth** ကို ရွေးချယ်ပါ
- **MiniMax M2.1** ကို ရွေးပါ

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 ကို fallback အဖြစ် (Opus primary)

**သင့်တော်သောအခြေအနေ:** Opus 4.6 ကို primary အဖြစ်ထားပြီး MiniMax M2.1 သို့ fail over ပြုလုပ်လိုပါက။

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### ရွေးချယ်နိုင်သောအချက်: LM Studio ဖြင့် Local (manual)

**Best for:** LM Studio ဖြင့် local inference လုပ်ရန်။
အစွမ်းထက် hardware (ဥပမာ desktop/server) ပေါ်တွင် LM Studio ၏ local server ကို အသုံးပြုသောအခါ MiniMax M2.1 နှင့် အလွန်ကောင်းသော ရလဒ်များကို တွေ့ရှိခဲ့ပါသည်။

`openclaw.json` မှတစ်ဆင့် manual ဖွဲ့စည်းပြင်ဆင်ပါ–

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## `openclaw configure` ဖြင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း

JSON ကို မတည်းဖြတ်ဘဲ MiniMax ကို သတ်မှတ်ရန် interactive config wizard ကို အသုံးပြုပါ–

1. `openclaw configure` ကို လုပ်ဆောင်ပါ။
2. **Model/auth** ကို ရွေးပါ။
3. **MiniMax M2.1** ကို ရွေးပါ။
4. မေးမြန်းသည့်အခါ default မော်ဒယ်ကို ရွေးချယ်ပါ။

## ဖွဲ့စည်းပြင်ဆင်မှု ရွေးချယ်စရာများ

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` (Anthropic-compatible) ကို ဦးစားပေးအသုံးပြုပါ; `https://api.minimax.io/v1` သည် OpenAI-compatible payload များအတွက် ရွေးချယ်နိုင်ပါသည်။
- `models.providers.minimax.api`: `anthropic-messages` ကို ဦးစားပေးအသုံးပြုပါ; `openai-completions` သည် OpenAI-compatible payload များအတွက် ရွေးချယ်နိုင်ပါသည်။
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`)။
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` ကို သတ်မှတ်ပါ။
- `agents.defaults.models`: allowlist ထဲတွင် အသုံးပြုလိုသော မော်ဒယ်များကို alias ပြုလုပ်ပါ။
- `models.mode`: built-in များနှင့်အတူ MiniMax ကို ထည့်သွင်းလိုပါက `merge` ကို ထားရှိပါ။

## မှတ်ချက်များ

- မော်ဒယ် ရည်ညွှန်းချက်များမှာ `minimax/<model>` ဖြစ်ပါသည်။
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (coding plan key လိုအပ်ပါသည်)။
- တိကျသော ကုန်ကျစရိတ် တွက်ချက်မှု လိုအပ်ပါက `models.json` တွင် စျေးနှုန်းတန်ဖိုးများကို ပြင်ဆင်ပါ။
- MiniMax Coding Plan အတွက် referral လင့်ခ် (10% လျှော့စျေး): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- provider စည်းမျဉ်းများအတွက် [/concepts/model-providers](/concepts/model-providers) ကို ကြည့်ပါ။
- ပြောင်းလဲရန် `openclaw models list` နှင့် `openclaw models set minimax/MiniMax-M2.1` ကို အသုံးပြုပါ။

## ပြဿနာဖြေရှင်းခြင်း

### “Unknown model: minimax/MiniMax-M2.1”

ဤအရာသည် ပုံမှန်အားဖြင့် **MiniMax provider ကို မconfigure လုပ်ထားခြင်း** (provider entry မရှိခြင်းနှင့် MiniMax auth profile/env key မတွေ့ရှိခြင်း) ကို ဆိုလိုပါသည်။ ဤ detection အတွက် fix တစ်ခုကို **2026.1.12** (ရေးသားချိန်တွင် မထုတ်ပြန်ရသေး) တွင် ထည့်သွင်းထားပါသည်။ ပြုပြင်ရန်:

- **2026.1.12** သို့ upgrade လုပ်ပါ (သို့မဟုတ် source မှ `main` ဖြင့် လည်ပတ်ပါ)၊ ထို့နောက် gateway ကို ပြန်လည်စတင်ပါ။
- `openclaw configure` ကို လုပ်ဆောင်ပြီး **MiniMax M2.1** ကို ရွေးချယ်ပါ၊ သို့မဟုတ်
- `models.providers.minimax` block ကို manual ထည့်သွင်းပါ၊ သို့မဟုတ်
- provider ကို inject ပြုလုပ်နိုင်ရန် `MINIMAX_API_KEY` (သို့မဟုတ် MiniMax auth profile) ကို သတ်မှတ်ပါ။

model id သည် **case‑sensitive** ဖြစ်ကြောင်း သေချာပါစေ–

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

ထို့နောက် အောက်ပါအတိုင်း ပြန်လည်စစ်ဆေးပါ–

```bash
openclaw models list
```
