---
summary: "GLM ماڈل خاندان کا جائزہ + OpenClaw میں اس کا استعمال کیسے کریں"
read_when:
  - آپ OpenClaw میں GLM ماڈلز چاہتے ہیں
  - آپ کو ماڈل نام رکھنے کے اصول اور سیٹ اپ درکار ہیں
title: "GLM ماڈلز"
---

# GLM ماڈلز

GLM is a **model family** (not a company) available through the Z.AI platform. In OpenClaw, GLM
models are accessed via the `zai` provider and model IDs like `zai/glm-4.7`.

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
