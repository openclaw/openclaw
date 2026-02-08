---
summary: "GLM ماڈل خاندان کا جائزہ + OpenClaw میں اس کا استعمال کیسے کریں"
read_when:
  - آپ OpenClaw میں GLM ماڈلز چاہتے ہیں
  - آپ کو ماڈل نام رکھنے کے اصول اور سیٹ اپ درکار ہیں
title: "GLM ماڈلز"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:30Z
---

# GLM ماڈلز

GLM ایک **ماڈل خاندان** ہے (کمپنی نہیں) جو Z.AI پلیٹ فارم کے ذریعے دستیاب ہے۔ OpenClaw میں، GLM
ماڈلز تک رسائی `zai` فراہم کنندہ کے ذریعے اور `zai/glm-4.7` جیسے ماڈل IDs کے ساتھ کی جاتی ہے۔

## CLI سیٹ اپ

```bash
openclaw onboard --auth-choice zai-api-key
```

## کنفیگ ٹکڑا

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## نوٹس

- GLM کے ورژنز اور دستیابی تبدیل ہو سکتی ہیں؛ تازہ ترین معلومات کے لیے Z.AI کی دستاویزات دیکھیں۔
- مثال کے طور پر ماڈل IDs میں `glm-4.7` اور `glm-4.6` شامل ہیں۔
- فراہم کنندہ کی تفصیلات کے لیے [/providers/zai](/providers/zai) دیکھیں۔
