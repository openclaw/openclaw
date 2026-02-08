---
summary: "OpenClaw သည် ပတ်ဝန်းကျင်ကိန်းရှင်များကို မည်သည့်နေရာများမှ တင်ယူသည်နှင့် ဦးစားပေးအစဉ်"
read_when:
  - မည်သည့် env vars များကို တင်ယူထားသည်နှင့် မည်သည့်အစဉ်အတိုင်းဖြစ်သည်ကို သိရန်လိုအပ်သောအခါ
  - Gateway တွင် API keys ပျောက်ဆုံးနေသည်ကို စစ်ဆေးနေသောအခါ
  - provider အတည်ပြုခြင်း သို့မဟုတ် တပ်ဆင်ထားသော ပတ်ဝန်းကျင်များကို စာရွက်တမ်းရေးသားနေသောအခါ
title: "ပတ်ဝန်းကျင်ကိန်းရှင်များ"
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:26Z
---

# ပတ်ဝန်းကျင်ကိန်းရှင်များ

OpenClaw သည် ပတ်ဝန်းကျင်ကိန်းရှင်များကို အရင်းအမြစ်များစွာမှ ဆွဲယူသည်။ စည်းမျဉ်းမှာ **ရှိပြီးသားတန်ဖိုးများကို မည်သည့်အခါမျှ မအစားထိုးပါ** ဖြစ်သည်။

## ဦးစားပေးအစဉ် (အမြင့်ဆုံး → အနိမ့်ဆုံး)

1. **Process environment** (မိဘ shell/daemon မှ Gateway process တွင် ရှိပြီးသား အရာများ)။
2. **လက်ရှိ အလုပ်လုပ်နေသော directory ထဲရှိ `.env`** (dotenv default; အစားမထိုးပါ)။
3. **`~/.openclaw/.env` တွင်ရှိသော Global `.env`** (aka `$OPENCLAW_STATE_DIR/.env`; အစားမထိုးပါ)။
4. **`~/.openclaw/openclaw.json` အတွင်းရှိ Config `env` block** (မရှိသေးလျှင်သာ သက်ရောက်စေသည်)။
5. **Optional login-shell import** (`env.shellEnv.enabled` သို့မဟုတ် `OPENCLAW_LOAD_SHELL_ENV=1`), မျှော်မှန်းထားသော ကီးများ မရှိသေးသည့်အခါတွင်သာ အသုံးပြုသည်။

Config ဖိုင်လုံးဝ မရှိပါက အဆင့် 4 ကို ကျော်လွှားမည်ဖြစ်ပြီး; shell import သည် ဖွင့်ထားပါက ဆက်လက် လုပ်ဆောင်မည်ဖြစ်သည်။

## Config `env` block

Inline env vars များကို သတ်မှတ်ရန် တူညီသော နည်းလမ်း ၂ မျိုး (နှစ်မျိုးလုံး အစားမထိုးပါ):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell env import

`env.shellEnv` သည် သင့် login shell ကို လည်ပတ်စေပြီး **မရှိသေးသော** မျှော်မှန်းထားသော ကီးများကိုသာ တင်သွင်းသည်—

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var အစားထိုးများ:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Config အတွင်း Env var အစားထိုးခြင်း

Config string တန်ဖိုးများအတွင်း `${VAR_NAME}` syntax ကို အသုံးပြုပြီး env vars များကို တိုက်ရိုက် ကိုးကားနိုင်သည်—

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

အသေးစိတ်အပြည့်အစုံအတွက် [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) ကို ကြည့်ပါ။

## ဆက်စပ်

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars နှင့် .env တင်ယူခြင်း](/help/faq#env-vars-and-env-loading)
- [Models အကြမ်းဖျဉ်း](/concepts/models)
