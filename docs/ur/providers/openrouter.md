---
summary: "OpenClaw میں متعدد ماڈلز تک رسائی کے لیے OpenRouter کی متحدہ API استعمال کریں"
read_when:
  - آپ متعدد LLMs کے لیے ایک ہی API کلید چاہتے ہیں
  - آپ OpenClaw میں OpenRouter کے ذریعے ماڈلز چلانا چاہتے ہیں
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:31Z
---

# OpenRouter

OpenRouter ایک **متحدہ API** فراہم کرتا ہے جو ایک ہی
اینڈپوائنٹ اور API کلید کے پیچھے متعدد ماڈلز تک درخواستوں کو روٹ کرتا ہے۔ یہ OpenAI کے مطابق ہے، اس لیے زیادہ تر OpenAI SDKs بیس URL تبدیل کرنے سے کام کر لیتے ہیں۔

## CLI سیٹ اپ

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## کنفیگ ٹکڑا

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

## نوٹس

- ماڈل حوالہ جات `openrouter/<provider>/<model>` ہیں۔
- مزید ماڈل/فراہم کنندہ کے اختیارات کے لیے [/concepts/model-providers](/concepts/model-providers) دیکھیں۔
- OpenRouter اندرونی طور پر آپ کی API کلید کے ساتھ Bearer ٹوکن استعمال کرتا ہے۔
