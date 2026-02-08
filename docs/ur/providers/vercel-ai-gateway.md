---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway کی سیٹ اپ (تصدیق + ماڈل انتخاب)"
read_when:
  - آپ OpenClaw کے ساتھ Vercel AI Gateway استعمال کرنا چاہتے ہیں
  - آپ کو API کلید کے ماحولیاتی متغیر یا CLI تصدیقی انتخاب کی ضرورت ہے
x-i18n:
  source_path: providers/vercel-ai-gateway.md
  source_hash: 2bf1687c1152c6e1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:35Z
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) ایک متحد API فراہم کرتا ہے جس کے ذریعے ایک ہی اینڈپوائنٹ سے سینکڑوں ماڈلز تک رسائی حاصل کی جا سکتی ہے۔

- فراہم کنندہ: `vercel-ai-gateway`
- تصدیق: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages کے ساتھ ہم آہنگ

## فوری آغاز

1. API کلید سیٹ کریں (سفارش کردہ: اسے Gateway کے لیے محفوظ کریں):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. ایک ڈیفالٹ ماڈل سیٹ کریں:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## غیر تعاملی مثال

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## ماحولیاتی نوٹ

اگر Gateway بطور ڈیمون (launchd/systemd) چل رہا ہو، تو یقینی بنائیں کہ `AI_GATEWAY_API_KEY`
اس پروسیس کے لیے دستیاب ہو (مثال کے طور پر، `~/.openclaw/.env` میں یا
`env.shellEnv` کے ذریعے)۔
