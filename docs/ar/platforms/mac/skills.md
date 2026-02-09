---
summary: "واجهة إعدادات Skills على macOS والحالة المدعومة عبر Gateway"
read_when:
  - تحديث واجهة إعدادات Skills على macOS
  - تغيير آليات تقييد Skills أو سلوك التثبيت
title: "Skills"
---

# Skills (macOS)

يعرض تطبيق macOS مهارات OpenClaw عبر Gateway؛ ولا يقوم بتحليل Skills محليًا.

## مصدر البيانات

- تقوم `skills.status` (Gateway) بإرجاع جميع Skills بالإضافة إلى الأهلية والمتطلبات المفقودة
  (بما في ذلك كتل قائمة السماح للمهارات المجمّعة).
- تُستمد المتطلبات من `metadata.openclaw.requires` ضمن كل `SKILL.md`.

## إجراءات التثبيت

- يحدد `metadata.openclaw.install` خيارات التثبيت (brew/node/go/uv).
- يستدعي التطبيق `skills.install` لتشغيل أدوات التثبيت على مضيف Gateway.
- يعرض Gateway مُثبّتًا مفضّلًا واحدًا فقط عند توفر عدة خيارات
  (brew عند توفره، وإلا فمدير node من `skills.install`، والافتراضي npm).

## مفاتيح Env/API

- يخزّن التطبيق المفاتيح في `~/.openclaw/openclaw.json` ضمن `skills.entries.<skillKey>`.
- تقوم `skills.update` بتحديث `enabled` و`apiKey` و`env`.

## الوضع البعيد

- تتم عمليات التثبيت وتحديثات التهيئة على مضيف Gateway (وليس على جهاز Mac المحلي).
