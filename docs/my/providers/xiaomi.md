---
summary: "OpenClaw နှင့် Xiaomi MiMo (mimo-v2-flash) ကို အသုံးပြုခြင်း"
read_when:
  - OpenClaw တွင် Xiaomi MiMo မော်ဒယ်များကို အသုံးပြုလိုပါက
  - XIAOMI_API_KEY ကို တပ်ဆင်ရန် လိုအပ်ပါက
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo is the API platform for **MiMo** models. It provides REST APIs compatible with
OpenAI and Anthropic formats and uses API keys for authentication. Create your API key in
the [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw uses
the `xiaomi` provider with a Xiaomi MiMo API key.

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
