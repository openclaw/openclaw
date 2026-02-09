---
summary: "استخدم Z.AI (نماذج GLM) مع OpenClaw"
read_when:
  - تريد نماذج Z.AI / GLM في OpenClaw
  - تحتاج إلى إعداد بسيط لمفتاح ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI هي منصة واجهات برمجة التطبيقات (API) لنماذج **GLM**. توفّر واجهات REST لنماذج GLM وتستخدم مفاتيح API للمصادقة. أنشئ مفتاح API الخاص بك في وحدة تحكّم Z.AI. يستخدم OpenClaw موفّر `zai` مع مفتاح Z.AI API.

## إعداد CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## مقتطف تهيئة

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## ملاحظات

- تتوفّر نماذج GLM على هيئة `zai/<model>` (مثال: `zai/glm-4.7`).
- راجع [/providers/glm](/providers/glm) للاطّلاع على نظرة عامة على عائلة النماذج.
- يستخدم Z.AI مصادقة Bearer مع مفتاح API الخاص بك.
