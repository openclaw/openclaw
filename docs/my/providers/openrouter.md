---
summary: "OpenClaw တွင် မော်ဒယ်များစွာကို အသုံးပြုနိုင်ရန် OpenRouter ၏ တစ်စုတစ်စည်း API ကို အသုံးပြုပါ"
read_when:
  - LLM များစွာအတွက် API key တစ်ခုတည်းကို အသုံးပြုလိုသောအခါ
  - OpenClaw အတွင်း OpenRouter မှတစ်ဆင့် မော်ဒယ်များကို အလုပ်လုပ်စေလိုသောအခါ
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Notes

- မော်ဒယ် ရည်ညွှန်းချက်များသည် `openrouter/<provider>/<model>` ဖြစ်ပါသည်။
- မော်ဒယ်/ပံ့ပိုးသူ ရွေးချယ်စရာများ ပိုမိုကြည့်ရှုရန် [/concepts/model-providers](/concepts/model-providers) ကို ကြည့်ပါ။
- OpenRouter သည် အတွင်းပိုင်းတွင် သင်၏ API key ကို Bearer token အဖြစ် အသုံးပြုပါသည်။
