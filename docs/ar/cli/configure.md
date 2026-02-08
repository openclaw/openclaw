---
summary: "مرجع CLI لأمر `openclaw configure` (مطالبات تهيئة تفاعلية)"
read_when:
  - عندما ترغب في ضبط بيانات الاعتماد أو الأجهزة أو القيم الافتراضية للوكيل بشكل تفاعلي
title: "التهيئة"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:00Z
---

# `openclaw configure`

مطالبة تفاعلية لإعداد بيانات الاعتماد والأجهزة والقيم الافتراضية للوكيل.

ملاحظة: يتضمن قسم **Model** الآن تحديدًا متعددًا لقائمة السماح
`agents.defaults.models` (ما الذي يظهر في `/model` ومُنتقي النموذج).

نصيحة: تشغيل `openclaw config` دون أمر فرعي يفتح المعالج نفسه. استخدم
`openclaw config get|set|unset` لإجراء تعديلات غير تفاعلية.

ذات صلة:

- مرجع تهيئة Gateway (البوابة): [Configuration](/gateway/configuration)
- CLI للتهيئة: [Config](/cli/config)

ملاحظات:

- اختيار مكان تشغيل Gateway (البوابة) يحدّث دائمًا `gateway.mode`. يمكنك تحديد «متابعة» دون أقسام أخرى إذا كان هذا كل ما تحتاجه.
- الخدمات الموجّهة حسب القناة (Slack/Discord/Matrix/Microsoft Teams) تطلب قوائم سماح للقنوات/الغرف أثناء الإعداد. يمكنك إدخال الأسماء أو المعرّفات؛ ويقوم المعالج بحلّ الأسماء إلى معرّفات عندما يكون ذلك ممكنًا.

## أمثلة

```bash
openclaw configure
openclaw configure --section models --section channels
```
