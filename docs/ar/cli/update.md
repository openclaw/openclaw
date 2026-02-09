---
summary: "مرجع CLI لأمر `openclaw update` (تحديث آمن نسبيًا للمصدر + إعادة تشغيل تلقائية لـ Gateway)"
read_when:
  - تريد تحديث نسخة مصدرية بأمان
  - تحتاج إلى فهم سلوك الاختصار `--update`
title: "تحديث"
---

# `openclaw update`

قم بتحديث OpenClaw بأمان والتبديل بين قنوات stable/beta/dev.

إذا قمت بالتثبيت عبر **npm/pnpm** (تثبيت عام دون بيانات تعريف git)، تتم التحديثات عبر مسار مدير الحزم الموضّح في [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: تخطّي إعادة تشغيل خدمة Gateway بعد نجاح التحديث.
- `--channel <stable|beta|dev>`: تعيين قناة التحديث (git + npm؛ محفوظة في التهيئة).
- `--tag <dist-tag|version>`: تجاوز dist-tag أو الإصدار في npm لهذا التحديث فقط.
- `--json`: طباعة JSON `UpdateRunResult` قابل للقراءة آليًا.
- `--timeout <seconds>`: مهلة لكل خطوة (الافتراضي 1200 ثانية).

ملاحظة: تتطلب عمليات الرجوع إلى إصدارات أقدم تأكيدًا لأن الإصدارات الأقدم قد تُعطّل التهيئة.

## `update status`

عرض قناة التحديث النشطة + وسم/فرع/SHA في git (لنسخ المصدر)، بالإضافة إلى توفر التحديثات.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: طباعة JSON حالة قابل للقراءة آليًا.
- `--timeout <seconds>`: مهلة لعمليات الفحص (الافتراضي 3 ثوانٍ).

## `update wizard`

تدفق تفاعلي لاختيار قناة تحديث وتأكيد ما إذا كان سيتم إعادة تشغيل Gateway
بعد التحديث (الافتراضي هو إعادة التشغيل). إذا اخترت `dev` دون نسخة git،
فسيعرض إنشاء واحدة.

## What it does

عند تبديل القنوات صراحةً (`--channel ...`)، يحافظ OpenClaw أيضًا على
مواءمة طريقة التثبيت:

- `dev` → يضمن وجود نسخة git (الافتراضي: `~/openclaw`، ويمكن التجاوز باستخدام `OPENCLAW_GIT_DIR`)،
  ويحدّثها، ويثبّت CLI العام من تلك النسخة.
- `stable`/`beta` → يثبّت من npm باستخدام dist-tag المطابق.

## Git checkout flow

Channels:

- `stable`: سحب أحدث وسم غير beta، ثم البناء + doctor.
- `beta`: سحب أحدث وسم `-beta`، ثم البناء + doctor.
- `dev`: سحب `main`، ثم الجلب + إعادة الأساس (rebase).

High-level:

1. يتطلب شجرة عمل نظيفة (دون تغييرات غير مُلتزم بها).
2. التبديل إلى القناة المحددة (وسم أو فرع).
3. جلب المستودع العلوي (dev فقط).
4. dev فقط: فحص أولي lint + بناء TypeScript في شجرة عمل مؤقتة؛ إذا فشل رأس الفرع، يتراجع حتى 10 التزامات للعثور على أحدث بناء نظيف.
5. إعادة الأساس إلى الالتزام المحدد (dev فقط).
6. تثبيت الاعتمادات (pnpm مفضّل؛ npm كخيار احتياطي).
7. البناء + بناء واجهة Control UI.
8. تشغيل `openclaw doctor` كفحص «تحديث آمن» نهائي.
9. مزامنة الإضافات مع القناة النشطة (يستخدم dev الامتدادات المضمّنة؛ وتستخدم stable/beta npm) وتحديث الإضافات المثبّتة عبر npm.

## `--update` shorthand

`openclaw --update` يُعاد كتابته إلى `openclaw update` (مفيد للأصداف وسكربتات التشغيل).

## See also

- `openclaw doctor` (يعرض تشغيل التحديث أولًا لنسخ git)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
