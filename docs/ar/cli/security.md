---
summary: "مرجع CLI لأمر `openclaw security` (تدقيق وإصلاح مزالق أمنية شائعة)"
read_when:
  - تريد تشغيل تدقيق أمني سريع على التهيئة/الحالة
  - تريد تطبيق اقتراحات «إصلاح» آمنة (chmod، تشديد الإعدادات الافتراضية)
title: "security"
---

# `openclaw security`

أدوات الأمان (تدقيق + إصلاحات اختيارية).

ذات صلة:

- دليل الأمان: [الأمان](/gateway/security)

## التدقيق

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

يحذّر التدقيق عندما يشترك عدة مرسلي رسائل خاصة (DM) في الجلسة الرئيسية، ويوصي بتفعيل **وضع DM الآمن**: `session.dmScope="per-channel-peer"` (أو `per-account-channel-peer` لقنوات متعددة الحسابات) لصناديق الوارد المشتركة.
كما يحذّر عند استخدام نماذج صغيرة (`<=300B`) دون sandboxing ومع تمكين أدوات الويب/المتصفح.
