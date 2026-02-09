---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway سیٹ اپ (تصدیق + ماڈل کا انتخاب)"
read_when:
  - آپ OpenClaw کے ساتھ Cloudflare AI Gateway استعمال کرنا چاہتے ہیں
  - آپ کو اکاؤنٹ ID، گیٹ وے ID، یا API کلید کے ماحولیاتی متغیر کی ضرورت ہے
---

# Cloudflare AI Gateway

Cloudflare AI Gateway فراہم کنندہ APIs کے سامنے ہوتا ہے اور آپ کو اینالیٹکس، کیشنگ اور کنٹرولز شامل کرنے دیتا ہے۔ Anthropic کے لیے، OpenClaw آپ کے Gateway اینڈپوائنٹ کے ذریعے Anthropic Messages API استعمال کرتا ہے۔

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (Gateway کے ذریعے درخواستوں کے لیے آپ کی فراہم کنندہ API کلید)

Anthropic ماڈلز کے لیے، اپنی Anthropic API کلید استعمال کریں۔

## Quick start

1. فراہم کنندہ API کلید اور Gateway کی تفصیلات سیٹ کریں:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. ایک ڈیفالٹ ماڈل سیٹ کریں:

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

اگر آپ نے Cloudflare میں Gateway تصدیق فعال کی ہے تو `cf-aig-authorization` ہیڈر شامل کریں (یہ آپ کی فراہم کنندہ API کلید کے علاوہ ہے)۔

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

اگر Gateway بطور ڈیمَن چل رہا ہو (launchd/systemd)، تو یقینی بنائیں کہ `CLOUDFLARE_AI_GATEWAY_API_KEY` اس عمل کے لیے دستیاب ہو (مثال کے طور پر `~/.openclaw/.env` میں یا `env.shellEnv` کے ذریعے)۔
