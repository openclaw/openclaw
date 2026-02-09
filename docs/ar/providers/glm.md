---
summary: "نظرة عامة على عائلة نماذج GLM + كيفية استخدامها في OpenClaw"
read_when:
  - تريد استخدام نماذج GLM في OpenClaw
  - تحتاج إلى اتفاقية تسمية النماذج والإعداد
title: "نماذج GLM"
---

# نماذج GLM

GLM هي **عائلة نماذج** (وليست شركة) متاحة عبر منصة Z.AI. في OpenClaw، يتم الوصول إلى نماذج GLM عبر موفّر `zai` ومعرّفات نماذج مثل `zai/glm-4.7`.

## إعداد CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## مقتطف تهيئة

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## ملاحظات

- يمكن أن تتغير إصدارات GLM وتوافرها؛ تحقّق من توثيق Z.AI للحصول على الأحدث.
- تتضمن أمثلة معرّفات النماذج `glm-4.7` و `glm-4.6`.
- لتفاصيل الموفّر، راجع [/providers/zai](/providers/zai).
