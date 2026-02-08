---
summary: "OpenClaw کے ساتھ Z.AI (GLM ماڈلز) استعمال کریں"
read_when:
  - آپ OpenClaw میں Z.AI / GLM ماڈلز چاہتے ہیں
  - آپ کو سادہ ZAI_API_KEY سیٹ اپ درکار ہے
title: "Z.AI"
x-i18n:
  source_path: providers/zai.md
  source_hash: 2c24bbad86cf86c3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:31Z
---

# Z.AI

Z.AI **GLM** ماڈلز کے لیے API پلیٹ فارم ہے۔ یہ GLM کے لیے REST APIs فراہم کرتا ہے اور تصدیق کے لیے API کیز استعمال کرتا ہے۔ Z.AI کنسول میں اپنی API کلید بنائیں۔ OpenClaw Z.AI API کلید کے ساتھ `zai` فراہم کنندہ استعمال کرتا ہے۔

## CLI سیٹ اپ

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## کنفیگ ٹکڑا

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## نوٹس

- GLM ماڈلز `zai/<model>` کے طور پر دستیاب ہیں (مثال: `zai/glm-4.7`)۔
- ماڈل فیملی کے جائزے کے لیے [/providers/glm](/providers/glm) دیکھیں۔
- Z.AI آپ کی API کلید کے ساتھ Bearer auth استعمال کرتا ہے۔
