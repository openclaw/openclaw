---
summary: "استخدام Xiaomi MiMo (mimo-v2-flash) مع OpenClaw"
read_when:
  - تريد استخدام نماذج Xiaomi MiMo في OpenClaw
  - تحتاج إلى إعداد XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo هي منصة واجهات برمجة التطبيقات لنماذج **MiMo**. توفّر واجهات REST متوافقة مع
تنسيقات OpenAI وAnthropic وتستخدم مفاتيح API للمصادقة. أنشئ مفتاح API الخاص بك في
[وحدة تحكم Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). يستخدم OpenClaw
الموفّر `xiaomi` مع مفتاح API الخاص بـ Xiaomi MiMo.

## نظرة عامة على النماذج

- **mimo-v2-flash**: نافذة سياق بسعة 262144 رمزًا، ومتوافق مع Anthropic Messages API.
- عنوان URL الأساسي: `https://api.xiaomimimo.com/anthropic`
- التفويض: `Bearer $XIAOMI_API_KEY`

## إعداد CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## مقتطف تهيئة

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## ملاحظات

- مرجع النموذج: `xiaomi/mimo-v2-flash`.
- يتم حقن الموفّر تلقائيًا عند تعيين `XIAOMI_API_KEY` (أو عند وجود ملف تعريف مصادقة).
- راجع [/concepts/model-providers](/concepts/model-providers) للاطلاع على قواعد الموفّرين.
