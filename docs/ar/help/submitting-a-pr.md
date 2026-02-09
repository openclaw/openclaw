---
summary: "كيفية تقديم PR عالي الإشارة"
title: "تقديم PR"
---

تكون PR الجيدة سهلة المراجعة: ينبغي أن يعرف المراجعون بسرعة القصد، ويتحققوا من السلوك، ويُدخلوا التغييرات بأمان. يغطي هذا الدليل عمليات تقديم موجزة وعالية الإشارة للمراجعة البشرية ومراجعة LLM.

## ما الذي يجعل PR جيدة

- [ ] اشرح المشكلة، ولماذا تهم، وما هو التغيير.
- [ ] حافظ على تركيز التغييرات. تجنب إعادة الهيكلة الواسعة.
- [ ] لخّص التغييرات المرئية للمستخدم/التهيئة/الإعدادات الافتراضية.
- [ ] اذكر تغطية الاختبارات، وما تم تخطيه، والأسباب.
- [ ] أضف أدلة: سجلات، لقطات شاشة، أو تسجيلات (UI/UX).
- [ ] كلمة المرور: ضع «lobster-biscuit» في وصف PR إذا قرأت هذا الدليل.
- [ ] شغّل/أصلح أوامر `pnpm` ذات الصلة قبل إنشاء PR.
- [ ] ابحث في قاعدة الشفرة وGitHub عن وظائف/مشكلات/إصلاحات ذات صلة.
- [ ] استند في الادعاءات إلى أدلة أو ملاحظات.
- [ ] عنوان جيد: فعل + نطاق + نتيجة (مثلًا: `Docs: add PR and issue templates`).

كن موجزًا؛ المراجعة الموجزة > القواعد اللغوية. احذف أي أقسام غير منطبقة.

### أوامر التحقق الأساسية (شغّل/أصلح الإخفاقات لتغييرك)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- تغييرات البروتوكول: `pnpm protocol:check`

## الإفصاح التدريجي

- الأعلى: الملخص/الغاية
- التالي: التغييرات/المخاطر
- التالي: الاختبار/التحقق
- الأخير: التنفيذ/الأدلة

## أنواع PR الشائعة: تفاصيل محددة

- [ ] إصلاح: أضف إعادة إنتاج المشكلة، السبب الجذري، والتحقق.
- [ ] ميزة: أضف حالات الاستخدام، السلوك/العروض/لقطات الشاشة (واجهة المستخدم).
- [ ] إعادة هيكلة: اذكر «لا تغيير في السلوك»، وعدّد ما تم نقله/تبسيطه.
- [ ] أعمال روتينية: اذكر السبب (مثلًا: وقت البناء، CI، الاعتماديات).
- [ ] توثيق: سياق قبل/بعد، رابط الصفحة المحدّثة، شغّل `pnpm format`.
- [ ] اختبار: ما الفجوة التي تُغطّى؛ وكيف يمنع التراجعات.
- [ ] أداء: أضف مقاييس قبل/بعد، وكيف تم القياس.
- [ ] UX/UI: لقطات شاشة/فيديو، واذكر أثر إمكانية الوصول.
- [ ] بنية تحتية/بناء: البيئات/التحقق.
- [ ] أمان: لخّص المخاطر، إعادة الإنتاج، التحقق، دون بيانات حساسة. ادعاءات مستندة فقط.

## قائمة التحقق

- [ ] مشكلة/غاية واضحة
- [ ] نطاق مركّز
- [ ] سرد تغييرات السلوك
- [ ] سرد الاختبارات ونتائجها
- [ ] خطوات اختبار يدوي (عند الاقتضاء)
- [ ] لا أسرار/بيانات خاصة
- [ ] مستندة إلى الأدلة

## قالب PR العام

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## قوالب أنواع PR (استبدل بنوعك)

### إصلاح

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### ميزة

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### إعادة هيكلة

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### أعمال روتينية/صيانة

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### توثيق

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### اختبار

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### بنية تحتية/بناء

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### أمان

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
