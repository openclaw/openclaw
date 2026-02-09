---
summary: "OpenClaw کے ساتھ Z.AI (GLM ماڈلز) استعمال کریں"
read_when:
  - آپ OpenClaw میں Z.AI / GLM ماڈلز چاہتے ہیں
  - آپ کو سادہ ZAI_API_KEY سیٹ اپ درکار ہے
title: "Z.AI"
---

# Z.AI

Z.AI **GLM** ماڈلز کے لیے API پلیٹ فارم ہے۔ یہ GLM کے لیے REST APIs فراہم کرتا ہے اور authentication کے لیے API keys استعمال کرتا ہے۔ Z.AI کنسول میں اپنی API key بنائیں۔ OpenClaw Z.AI API key کے ساتھ `zai` provider استعمال کرتا ہے۔

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
