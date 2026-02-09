---
summary: "تطبيق تصحيحات متعددة الملفات باستخدام أداة apply_patch"
read_when:
  - تحتاج إلى تعديلات ملفات منظَّمة عبر عدة ملفات
  - تريد توثيق أو تصحيح أخطاء تعديلات قائمة على التصحيحات
title: "أداة apply_patch"
---

# أداة apply_patch

تطبيق تغييرات الملفات باستخدام تنسيق تصحيح منظَّم. يُعد هذا مثاليًا للتعديلات متعددة الملفات
أو متعددة المقاطع (hunks) حيث يكون استدعاء واحد `edit` هشًّا.

تقبل الأداة سلسلة واحدة `input` تلتف حول عملية واحدة أو أكثر على الملفات:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## المعلمات

- `input` (مطلوب): محتويات التصحيح كاملة بما في ذلك `*** Begin Patch` و `*** End Patch`.

## ملاحظات

- تُحلّ المسارات نسبةً إلى جذر مساحة العمل.
- استخدم `*** Move to:` داخل مقطع `*** Update File:` لإعادة تسمية الملفات.
- تشير `*** End of File` إلى إدراج عند نهاية الملف فقط عند الحاجة.
- تجريبية ومعطّلة افتراضيًا. فعِّلها باستخدام `tools.exec.applyPatch.enabled`.
- متاحة لـ OpenAI فقط (بما في ذلك OpenAI Codex). يمكن اختياريًا تقييدها حسب النموذج عبر
  `tools.exec.applyPatch.allowModels`.
- تكون التهيئة فقط ضمن `tools.exec`.

## مثال

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
