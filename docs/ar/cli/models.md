---
summary: "مرجع CLI لأمر `openclaw models` ‏(الحالة/القائمة/التعيين/الفحص، الأسماء المستعارة، البدائل، المصادقة)"
read_when:
  - تريد تغيير النماذج الافتراضية أو عرض حالة مصادقة الموفّرين
  - تريد فحص النماذج/الموفّرين المتاحين وتصحيح أخطاء ملفات تعريف المصادقة
title: "models"
---

# `openclaw models`

اكتشاف النماذج وفحصها وتهيئتها (النموذج الافتراضي، البدائل، ملفات تعريف المصادقة).

ذو صلة:

- الموفّرون + النماذج: [Models](/providers/models)
- إعداد مصادقة الموفّر: [بدء الاستخدام](/start/getting-started)

## الأوامر الشائعة

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

يعرض `openclaw models status` الإعدادات المحلولة للنموذج الافتراضي/البدائل إضافةً إلى نظرة عامة على المصادقة.
عند توفّر لقطات استخدام الموفّر، يتضمن قسم حالة OAuth/الرموز المميِّزة
ترويسات استخدام الموفّر.
أضِف `--probe` لتشغيل مجسّات مصادقة حيّة مقابل كل ملف تعريف موفّر مُهيّأ.
المجسّات هي طلبات حقيقية (قد تستهلك رموزًا وتُفعِّل حدود المعدّل).
استخدم `--agent <id>` لفحص حالة النموذج/المصادقة لوكيل مُهيّأ. عند الإغفال،
يستخدم الأمر `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` إذا كانا مُعيّنين، وإلا
الوكيل الافتراضي المُهيّأ.

ملاحظات:

- يقبل `models set <model-or-alias>` قيمة `provider/model` أو اسمًا مستعارًا.
- تُحلَّل مراجع النماذج عبر التقسيم عند **أول** `/`. إذا كان معرّف النموذج يتضمن `/` (على نمط OpenRouter)، فضمِّن بادئة الموفّر (مثال: `openrouter/moonshotai/kimi-k2`).
- إذا حذفت الموفّر، يعامل OpenClaw الإدخال على أنه اسم مستعار أو نموذج للـ **موفّر الافتراضي** (يعمل فقط عندما لا يوجد `/` في معرّف النموذج).

### `models status`

الخيارات:

- `--json`
- `--plain`
- `--check` (الخروج 1=منتهي/مفقود، 2=على وشك الانتهاء)
- `--probe` (فحص حيّ لملفات تعريف المصادقة المُهيّأة)
- `--probe-provider <name>` (فحص موفّر واحد)
- `--probe-profile <id>` (تكرار أو مُعرّفات ملفات تعريف مفصولة بفواصل)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (معرّف وكيل مُهيّأ؛ يتجاوز `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## الأسماء المستعارة + الرجوع

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## ملفات تعريف المصادقة

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

يشغّل `models auth login` تدفّق مصادقة إضافة الموفّر (OAuth/مفتاح API). استخدم
`openclaw plugins list` لمعرفة الموفّرين المُثبّتين.

ملاحظات:

- يطلب `setup-token` قيمة رمز إعداد (يمكن توليده باستخدام `claude setup-token` على أي جهاز).
- يقبل `paste-token` سلسلة رمز تم توليدها في مكان آخر أو عبر الأتمتة.
