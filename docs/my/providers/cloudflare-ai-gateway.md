---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway ကို တပ်ဆင်ခြင်း (auth + မော်ဒယ် ရွေးချယ်မှု)"
read_when:
  - OpenClaw နှင့် Cloudflare AI Gateway ကို အသုံးပြုလိုသောအခါ
  - account ID၊ gateway ID သို့မဟုတ် API key env var ကို လိုအပ်သောအခါ
x-i18n:
  source_path: providers/cloudflare-ai-gateway.md
  source_hash: db77652c37652ca2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:40Z
---

# Cloudflare AI Gateway

Cloudflare AI Gateway သည် provider API များ၏ ရှေ့ဘက်တွင် တည်ရှိပြီး analytics၊ caching နှင့် ထိန်းချုပ်မှုများကို ထည့်သွင်းနိုင်စေပါသည်။ Anthropic အတွက် OpenClaw သည် သင့် Gateway endpoint မှတစ်ဆင့် Anthropic Messages API ကို အသုံးပြုပါသည်။

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (Gateway မှတစ်ဆင့် တောင်းဆိုမှုများအတွက် သင့် provider API key)

Anthropic မော်ဒယ်များအတွက် သင့် Anthropic API key ကို အသုံးပြုပါ။

## Quick start

1. provider API key နှင့် Gateway အသေးစိတ်များကို သတ်မှတ်ပါ-

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. default model တစ်ခုကို သတ်မှတ်ပါ-

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Authenticated gateways

Cloudflare တွင် Gateway authentication ကို ဖွင့်ထားပါက `cf-aig-authorization` header ကို ထည့်ပါ (ဤအရာသည် သင့် provider API key အပြင် ထပ်မံလိုအပ်ပါသည်)။

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## Environment note

Gateway ကို daemon (launchd/systemd) အဖြစ် လည်ပတ်စေပါက `CLOUDFLARE_AI_GATEWAY_API_KEY` သည် ထို process မှ အသုံးပြုနိုင်ကြောင်း သေချာစေရပါမည် (ဥပမာအားဖြင့် `~/.openclaw/.env` ထဲတွင် သို့မဟုတ် `env.shellEnv` မှတစ်ဆင့်)။
