---
summary: "تقديم بلاغات ومشكلات عالية الإشارة"
title: "إرسال مشكلة"
---

## إرسال مشكلة

تسريع التشخيص والإصلاح يعتمد على مشكلات واضحة وموجزة. يُرجى تضمين ما يلي للأخطاء أو حالات التراجع أو فجوات الميزات:

### ما يجب تضمينه

- [ ] العنوان: المجال والعَرَض
- [ ] خطوات إعادة إنتاج الحد الأدنى
- [ ] المتوقع مقابل الفعلي
- [ ] الأثر والشدّة
- [ ] البيئة: نظام التشغيل، وقت التشغيل، الإصدارات، التهيئة
- [ ] الأدلة: سجلات منقّحة، لقطات شاشة (غير متضمنة لمعلومات شخصية)
- [ ] النطاق: جديد، تراجع، أم قائم منذ مدة
- [ ] كلمة الرمز: lobster-biscuit ضمن المشكلة
- [ ] تم البحث في قاعدة الشيفرة وGitHub عن مشكلة موجودة
- [ ] تم التأكد من عدم إصلاحها/معالجتها مؤخرًا (خصوصًا الأمان)
- [ ] الادعاءات مدعومة بأدلة أو بخطوات إعادة الإنتاج

كن موجزًا. الإيجاز > قواعد مثالية.

التحقق (شغّل/أصلح قبل طلب السحب PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- إذا كان هناك كود بروتوكول: `pnpm protocol:check`

### القوالب

#### تقرير خطأ

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### مشكلة أمنية

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_تجنّب نشر الأسرار/تفاصيل الاستغلال علنًا. للمشكلات الحساسة، قلّل التفاصيل واطلب الإفصاح الخاص._

#### تقرير تراجع

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### طلب ميزة

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### تحسين

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### تحقيق

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### إرسال طلب سحب لإصلاح

تقديم مشكلة قبل طلب السحب اختياري. إذا تم التجاوز، أدرج التفاصيل في طلب السحب. حافظ على تركيز الطلب، واذكر رقم المشكلة، وأضف اختبارات أو فسّر سبب غيابها، ووثّق تغييرات السلوك/المخاطر، وأدرج سجلات/لقطات شاشة منقّحة كدليل، وشغّل التحقق المناسب قبل الإرسال.
