---
summary: "استخدم OAuth من Qwen (الفئة المجانية) في OpenClaw"
read_when:
  - تريد استخدام Qwen مع OpenClaw
  - تريد وصول OAuth من الفئة المجانية إلى Qwen Coder
title: "Qwen"
---

# Qwen

يوفّر Qwen تدفّق OAuth من الفئة المجانية لنماذج Qwen Coder وQwen Vision
(2,000 طلب/اليوم، وفق حدود المعدّل الخاصة بـ Qwen).

## تمكين الإضافة

```bash
openclaw plugins enable qwen-portal-auth
```

أعد تشغيل Gateway بعد التمكين.

## المصادقة

```bash
openclaw models auth login --provider qwen-portal --set-default
```

يشغّل هذا تدفّق OAuth برمز الجهاز لـ Qwen ويكتب مُدخل موفّر إلى
`models.json` (بالإضافة إلى الاسم المستعار `qwen` للتبديل السريع).

## معرّفات النماذج

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

بدّل النماذج باستخدام:

```bash
openclaw models set qwen-portal/coder-model
```

## إعادة استخدام تسجيل دخول Qwen Code CLI

إذا كنت قد سجّلت الدخول مسبقًا باستخدام Qwen Code CLI، فسيقوم OpenClaw بمزامنة بيانات الاعتماد
من `~/.qwen/oauth_creds.json` عند تحميل مخزن المصادقة. لا تزال بحاجة إلى مُدخل
`models.providers.qwen-portal` (استخدم أمر تسجيل الدخول أعلاه لإنشائه).

## ملاحظات

- تُحدَّث الرموز تلقائيًا؛ أعد تشغيل أمر تسجيل الدخول إذا فشل التحديث أو تم سحب الوصول.
- عنوان URL الأساسي الافتراضي: `https://portal.qwen.ai/v1` (يمكن تجاوزه باستخدام
  `models.providers.qwen-portal.baseUrl` إذا وفّرت Qwen نقطة نهاية مختلفة).
- راجع [موفّري النماذج](/concepts/model-providers) للاطلاع على القواعد العامة على مستوى الموفّر.
