---
summary: "OpenClaw တွင် မော်ဒယ်များစွာကို အသုံးပြုနိုင်ရန် OpenRouter ၏ တစ်စုတစ်စည်း API ကို အသုံးပြုပါ"
read_when:
  - "LLM များစွာအတွက် API key တစ်ခုတည်းကို အသုံးပြုလိုသောအခါ"
  - "OpenClaw အတွင်း OpenRouter မှတစ်ဆင့် မော်ဒယ်များကို အလုပ်လုပ်စေလိုသောအခါ"
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:43Z
---

# OpenRouter

OpenRouter သည် endpoint တစ်ခုနှင့် API key တစ်ခုတည်းအောက်တွင် မော်ဒယ်များစွာသို့ တောင်းဆိုမှုများကို လမ်းကြောင်းပြောင်းပေးသော **တစ်စုတစ်စည်း API** ကို ပံ့ပိုးပေးပါသည်။ ၎င်းသည် OpenAI နှင့် ကိုက်ညီမှုရှိသောကြောင့် base URL ကို ပြောင်းလဲခြင်းဖြင့် OpenAI SDK များအများစုကို အသုံးပြုနိုင်ပါသည်။

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
