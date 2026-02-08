---
summary: "Moonshot K2 နှင့် Kimi Coding ကို ချိန်ညှိတပ်ဆင်ခြင်း (ပံ့ပိုးသူများနှင့် ကီးများကို ခွဲခြားအသုံးပြုခြင်း)"
read_when:
  - Moonshot K2 (Moonshot Open Platform) နှင့် Kimi Coding ကို တပ်ဆင်ချိန်ညှိလိုသောအခါ
  - ခွဲခြားထားသော endpoint များ၊ ကီးများနှင့် မော်ဒယ် ရည်ညွှန်းချက်များကို နားလည်လိုသောအခါ
  - ပံ့ပိုးသူ တစ်ခုချင်းစီအတွက် ကော်ပီ/ပိတ်စ် ချိန်ညှိဖိုင်ကို လိုအပ်သောအခါ
title: "Moonshot AI"
x-i18n:
  source_path: providers/moonshot.md
  source_hash: 9e4a6192faa21b88
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:46Z
---

# Moonshot AI (Kimi)

Moonshot သည် OpenAI နှင့် ကိုက်ညီသော endpoint များဖြင့် Kimi API ကို ပံ့ပိုးပေးသည်။ ပံ့ပိုးသူကို ချိန်ညှိပြီး မူလ မော်ဒယ်ကို `moonshot/kimi-k2.5` အဖြစ် သတ်မှတ်ပါ၊ သို့မဟုတ်
Kimi Coding ကို `kimi-coding/k2p5` ဖြင့် အသုံးပြုနိုင်သည်။

လက်ရှိ Kimi K2 မော်ဒယ် ID များ:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

မှတ်ချက်: Moonshot နှင့် Kimi Coding သည် သီးခြား ပံ့ပိုးသူများ ဖြစ်သည်။ ကီးများကို အပြန်အလှန် မသုံးနိုင်ပါ၊ endpoint များကွဲပြားပြီး မော်ဒယ် ရည်ညွှန်းချက်များလည်း ကွဲပြားသည် (Moonshot သည် `moonshot/...` ကို အသုံးပြုပြီး၊ Kimi Coding သည် `kimi-coding/...` ကို အသုံးပြုသည်)။

## Config snippet (Moonshot API)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## Notes

- Moonshot မော်ဒယ် ရည်ညွှန်းချက်များသည် `moonshot/<modelId>` ကို အသုံးပြုသည်။ Kimi Coding မော်ဒယ် ရည်ညွှန်းချက်များသည် `kimi-coding/<modelId>` ကို အသုံးပြုသည်။
- လိုအပ်ပါက စျေးနှုန်းနှင့် context မီတာဒေတာကို `models.providers` တွင် အစားထိုး သတ်မှတ်နိုင်သည်။
- မော်ဒယ်တစ်ခုအတွက် Moonshot က context ကန့်သတ်ချက် မတူညီစွာ ထုတ်ပြန်ပါက
  `contextWindow` ကို လိုက်လျောညီထွေ ချိန်ညှိပါ။
- နိုင်ငံတကာ endpoint အတွက် `https://api.moonshot.ai/v1` ကို အသုံးပြုပါ၊ တရုတ် endpoint အတွက် `https://api.moonshot.cn/v1` ကို အသုံးပြုပါ။
