---
summary: "ဒေသတွင်း LLM များ (LM Studio, vLLM, LiteLLM, custom OpenAI endpoints) ပေါ်တွင် OpenClaw ကို လည်ပတ်ခြင်း"
read_when:
  - သင့်ကိုယ်ပိုင် GPU စက်ပေါ်မှ မော်ဒယ်များကို ဝန်ဆောင်မှုပေးလိုသောအခါ
  - LM Studio သို့မဟုတ် OpenAI-compatible proxy ကို ချိတ်ဆက်တပ်ဆင်နေသောအခါ
  - ဒေသတွင်း မော်ဒယ်များအတွက် အလုံခြုံဆုံး လမ်းညွှန်ချက်များ လိုအပ်သောအခါ
title: "Local Models"
---

# Local models

Local အနေဖြင့် လုပ်နိုင်သော်လည်း OpenClaw သည် context ကြီးမားမှုနှင့် prompt injection ကို တင်းကျပ်စွာ ကာကွယ်နိုင်မှုကို မျှော်လင့်ထားသည်။ ကတ်အသေးများသည် context ကို ဖြတ်တောက်ပြီး လုံခြုံရေးကို ယို漏စေနိုင်သည်။ ရည်မှန်းချက်ကို မြင့်မားစွာထားပါ: **≥2 အပြည့်အဝ အင်အားမြှင့်ထားသော Mac Studio များ သို့မဟုတ် တူညီသော GPU rig (~$30k+)**။ **24 GB** GPU တစ်ခုတည်းဖြင့်တော့ ပိုမိုပေါ့ပါးသော prompt များတွင်သာ အသုံးပြုနိုင်ပြီး latency ပိုများမည်။ သင် လည်ပတ်နိုင်သမျှ **အကြီးဆုံး / full-size model variant ကို အသုံးပြုပါ**; အလွန်အမင်း quantized လုပ်ထားသော သို့မဟုတ် “small” checkpoint များသည် prompt-injection အန္တရာယ်ကို တိုးစေသည် ([Security](/gateway/security) ကိုကြည့်ပါ)။

## အကြံပြုချက်: LM Studio + MiniMax M2.1 (Responses API, full-size)

လက်ရှိ အကောင်းဆုံး local stack။ LM Studio တွင် MiniMax M2.1 ကို load လုပ်ပြီး local server ကို ဖွင့်ပါ (မူလ `http://127.0.0.1:1234`)， reasoning ကို final text မှ ခွဲထားရန် Responses API ကို အသုံးပြုပါ။

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
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

**Setup checklist**

- LM Studio ကို ထည့်သွင်းတပ်ဆင်ပါ: [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio အတွင်း **ရရှိနိုင်သမျှ အကြီးဆုံး MiniMax M2.1 build** ကို ဒေါင်းလုဒ်လုပ်ပါ (“small”/အလွန်အကျွံ quantize လုပ်ထားသော variant များကို ရှောင်ပါ)၊ server ကို စတင်ပြီး `http://127.0.0.1:1234/v1/models` တွင် စာရင်းပေါ်နေသည်ကို အတည်ပြုပါ။
- မော်ဒယ်ကို load လုပ်ထားပါ; cold-load ပြုလုပ်ပါက startup latency တိုးလာပါမည်။
- သင့် LM Studio build မတူညီပါက `contextWindow`/`maxTokens` ကို ချိန်ညှိပါ။
- WhatsApp အတွက် final text ကိုသာ ပို့ရန် Responses API ကိုသာ အသုံးပြုပါ။

ဒေသတွင်း လည်ပတ်နေစဉ်တောင် hosted မော်ဒယ်များကို configure လုပ်ထားပါ; fallback များ ဆက်လက်ရရှိနေစေရန် `models.mode: "merge"` ကို အသုံးပြုပါ။

### Hybrid config: hosted primary, local fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
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

### Local-first with hosted safety net

primary နှင့် fallback အစီအစဉ်ကို လဲလှယ်ပါ; providers block ကို အတူတူထားပြီး `models.mode: "merge"` ကို ထားရှိပါ။ ဒေသတွင်း စက် ပိတ်သွားပါက Sonnet သို့မဟုတ် Opus သို့ fallback ပြုလုပ်နိုင်ပါမည်။

### Regional hosting / data routing

- Hosted MiniMax/Kimi/GLM variant များကို OpenRouter ပေါ်တွင် region-pinned endpoint များ (ဥပမာ US-hosted) အဖြစ်လည်း ရရှိနိုင်သည်။ သင် ရွေးချယ်ထားသော ဥပဒေအာဏာပိုင်ဒေသအတွင်း traffic ကို ထိန်းထားရန် ထိုနေရာမှ regional variant ကို ရွေးပြီး Anthropic/OpenAI fallback များအတွက် `models.mode: "merge"` ကို ဆက်လက် အသုံးပြုပါ။
- ဒေသတွင်းသာ အသုံးပြုခြင်းသည် privacy အတွက် အကောင်းဆုံး လမ်းကြောင်း ဖြစ်ပါသည်; provider အင်္ဂါရပ်များ လိုအပ်သော်လည်း data flow ကို ထိန်းချုပ်လိုပါက hosted regional routing သည် အလယ်အလတ် ဖြေရှင်းချက် ဖြစ်ပါသည်။

## အခြား OpenAI-compatible local proxy များ

vLLM, LiteLLM, OAI-proxy သို့မဟုတ် custom gateways များသည် OpenAI ပုံစံ `/v1` endpoint ကို ဖော်ထုတ်ပေးပါက အသုံးပြုနိုင်ပါသည်။ အပေါ်ရှိ provider block ကို သင့် endpoint နှင့် model ID ဖြင့် အစားထိုးပါ:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

hosted မော်ဒယ်များကို fallback အဖြစ် ဆက်လက်ရရှိစေရန် `models.mode: "merge"` ကို ထားရှိပါ။

## Troubleshooting

- Gateway က proxy ကို ချိတ်ဆက်နိုင်ပါသလား? `curl http://127.0.0.1:1234/v1/models`
- LM Studio model ကို unload လုပ်ထားပါသလား? ပြန်လည် load လုပ်ပါ; cold start သည် “hanging” ဖြစ်စေသော အကြောင်းရင်း အများဆုံးဖြစ်သည်။
- Context အမှားများ ရှိပါသလား? `contextWindow` ကို လျှော့ချပါ သို့မဟုတ် server limit ကို မြှင့်ပါ။
- Safety: ဒေသတွင်း မော်ဒယ်များတွင် provider-side filter များ မပါဝင်ပါ; prompt injection ၏ ထိခိုက်မှု အကျယ်အဝန်းကို ကန့်သတ်ရန် agents များကို ကျဉ်းမြောင်းစေပြီး compaction ကို ဖွင့်ထားပါ။
