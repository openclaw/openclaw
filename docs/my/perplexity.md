---
summary: "web_search အတွက် Perplexity Sonar ကို တပ်ဆင်ပြင်ဆင်ခြင်း"
read_when:
  - web search အတွက် Perplexity Sonar ကို အသုံးပြုလိုသည့်အခါ
  - PERPLEXITY_API_KEY သို့မဟုတ် OpenRouter တပ်ဆင်မှု လိုအပ်သည့်အခါ
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw can use Perplexity Sonar for the `web_search` tool. 1. သင်သည် Perplexity ၏ တိုက်ရိုက် API မှတဆင့် သို့မဟုတ် OpenRouter မှတဆင့် ချိတ်ဆက်နိုင်ပါသည်။

## API ရွေးချယ်စရာများ

### Perplexity (တိုက်ရိုက်)

- Base URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- ပတ်ဝန်းကျင်ကိန်းရှင်: `PERPLEXITY_API_KEY`

### OpenRouter (အစားထိုး)

- Base URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- ပတ်ဝန်းကျင်ကိန်းရှင်: `OPENROUTER_API_KEY`
- ကြိုတင်ငွေဖြည့်/crypto ခရက်ဒစ်များကို ထောက်ပံ့သည်။

## Config ဥပမာ

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Brave မှ ပြောင်းလဲခြင်း

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

`PERPLEXITY_API_KEY` နှင့် `OPENROUTER_API_KEY` နှစ်ခုလုံးကို သတ်မှတ်ထားပါက မရှုပ်ထွေးစေရန်
`tools.web.search.perplexity.baseUrl` (သို့မဟုတ် `tools.web.search.perplexity.apiKey`)
ကို သတ်မှတ်ပါ။

Base URL ကို မသတ်မှတ်ထားပါက OpenClaw သည် API key အရင်းအမြစ်ပေါ်မူတည်၍ မူလတန်ဖိုးကို ရွေးချယ်ပါသည်။

- `PERPLEXITY_API_KEY` သို့မဟုတ် `pplx-...` → တိုက်ရိုက် Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` သို့မဟုတ် `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- မသိသော key ဖော်မတ်များ → OpenRouter (ဘေးကင်းသော အစားထိုး)

## မော်ဒယ်များ

- `perplexity/sonar` — web search ပါဝင်သော အမြန် Q&A
- `perplexity/sonar-pro` (မူလ) — အဆင့်လိုက် အကြောင်းပြချက်ချ + web search
- `perplexity/sonar-reasoning-pro` — အနက်ရှိုင်းသော သုတေသန

web_search ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံအတွက် [Web tools](/tools/web) ကို ကြည့်ရှုပါ။
