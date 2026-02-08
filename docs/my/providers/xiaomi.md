---
summary: "OpenClaw နှင့် Xiaomi MiMo (mimo-v2-flash) ကို အသုံးပြုခြင်း"
read_when:
  - OpenClaw တွင် Xiaomi MiMo မော်ဒယ်များကို အသုံးပြုလိုပါက
  - XIAOMI_API_KEY ကို တပ်ဆင်ရန် လိုအပ်ပါက
title: "Xiaomi MiMo"
x-i18n:
  source_path: providers/xiaomi.md
  source_hash: 366fd2297b2caf8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:46Z
---

# Xiaomi MiMo

Xiaomi MiMo သည် **MiMo** မော်ဒယ်များအတွက် API ပလက်ဖောင်းဖြစ်သည်။ OpenAI နှင့် Anthropic ဖော်မတ်များနှင့် ကိုက်ညီသော REST API များကို ပံ့ပိုးပေးပြီး အတည်ပြုရန်အတွက် API key များကို အသုံးပြုသည်။ သင်၏ API key ကို [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys) တွင် ဖန်တီးပါ။ OpenClaw သည် Xiaomi MiMo API key နှင့်အတူ `xiaomi` provider ကို အသုံးပြုသည်။

## Model overview

- **mimo-v2-flash**: 262144-token context window၊ Anthropic Messages API နှင့် ကိုက်ညီသည်။
- Base URL: `https://api.xiaomimimo.com/anthropic`
- Authorization: `Bearer $XIAOMI_API_KEY`

## CLI setup

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Config snippet

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notes

- Model ref: `xiaomi/mimo-v2-flash`။
- `XIAOMI_API_KEY` ကို သတ်မှတ်ထားပါက (သို့မဟုတ် auth profile တစ်ခု ရှိပါက) provider ကို အလိုအလျောက် ထည့်သွင်းပေးသည်။
- Provider စည်းမျဉ်းများအတွက် [/concepts/model-providers](/concepts/model-providers) ကို ကြည့်ပါ။
