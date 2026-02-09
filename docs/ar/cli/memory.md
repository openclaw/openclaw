---
summary: "مرجع CLI لأمر `openclaw memory` (الحالة/الفهرسة/البحث)"
read_when:
  - تريد فهرسة الذاكرة الدلالية أو البحث فيها
  - تقوم باستكشاف أخطاء توفر الذاكرة أو الفهرسة وإصلاحها
title: "الذاكرة"
---

# `openclaw memory`

إدارة فهرسة الذاكرة الدلالية والبحث.
يتم توفيرها بواسطة مكوّن الذاكرة الإضافي النشط (الافتراضي: `memory-core`؛ عيّن `plugins.slots.memory = "none"` للتعطيل).

ذات صلة:

- مفهوم الذاكرة: [Memory](/concepts/memory)
- المكونات الإضافية: [Plugins](/tools/plugin)

## أمثلة

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## خيارات

عام:

- `--agent <id>`: حصر النطاق في وكيل واحد (الافتراضي: جميع الوكلاء المهيأين).
- `--verbose`: إخراج سجلات تفصيلية أثناء عمليات الفحص والفهرسة.

ملاحظات:

- `memory status --deep` يفحص توفر المتجهات + التضمينات.
- `memory status --deep --index` يُجري إعادة فهرسة إذا كان المخزن متسخًا.
- `memory index --verbose` يطبع تفاصيل لكل مرحلة (الموفّر، النموذج، المصادر، نشاط الدُفعات).
- `memory status` يتضمن أي مسارات إضافية مهيأة عبر `memorySearch.extraPaths`.
