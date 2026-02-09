---
summary: "استخدم واجهة برمجة التطبيقات الموحّدة من OpenRouter للوصول إلى العديد من النماذج في OpenClaw"
read_when:
  - تريد مفتاح API واحدًا للعديد من نماذج LLM
  - تريد تشغيل النماذج عبر OpenRouter داخل OpenClaw
title: "OpenRouter"
---

# OpenRouter

يوفّر OpenRouter **واجهة برمجة تطبيقات موحّدة** تقوم بتوجيه الطلبات إلى العديد من النماذج خلف نقطة نهاية واحدة ومفتاح API واحد. وهو متوافق مع OpenAI، لذا تعمل معظم حِزم SDK الخاصة بـ OpenAI عبر تبديل عنوان URL الأساسي.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

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

## Notes

- مراجع النماذج هي `openrouter/<provider>/<model>`.
- لمزيد من خيارات النماذج/الموفّرين، راجع [/concepts/model-providers](/concepts/model-providers).
- يستخدم OpenRouter رمز Bearer مع مفتاح API الخاص بك خلف الكواليس.
