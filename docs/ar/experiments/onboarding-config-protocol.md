---
summary: "ملاحظات بروتوكول RPC لمعالج التهيئة الأولية ومخطط التهيئة"
read_when: "عند تغيير خطوات معالج التهيئة الأولية أو نقاط نهاية مخطط التهيئة"
title: "التهيئة الأولية وبروتوكول التهيئة"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:07Z
---

# التهيئة الأولية + بروتوكول التهيئة

الغرض: أسطح مشتركة للتهيئة الأولية والتهيئة عبر CLI وتطبيق macOS وواجهة الويب.

## المكوّنات

- محرك المعالج (جلسة مشتركة + مطالبات + حالة التهيئة الأولية).
- تستخدم التهيئة الأولية عبر CLI نفس تدفّق المعالج المستخدم لدى عملاء واجهة المستخدم.
- يعرِض Gateway RPC نقاط نهاية للمعالج ومخطط التهيئة.
- تستخدم التهيئة الأولية على macOS نموذج خطوات المعالج.
- تعرض واجهة الويب نماذج التهيئة اعتمادًا على JSON Schema + تلميحات واجهة المستخدم.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

الاستجابات (البنية)

- المعالج: `{ sessionId, done, step?, status?, error? }`
- مخطط التهيئة: `{ schema, uiHints, version, generatedAt }`

## تلميحات واجهة المستخدم

- `uiHints` مُفهرسة حسب المسار؛ بيانات وصفية اختيارية (label/help/group/order/advanced/sensitive/placeholder).
- تُعرَض الحقول الحسّاسة كمدخلات كلمة مرور؛ بدون طبقة تنقيح.
- تعود عُقد المخطط غير المدعومة إلى محرّر JSON الخام.

## ملاحظات

- هذا المستند هو المكان الوحيد لتتبّع إعادة هيكلة البروتوكول الخاصة بالتهيئة الأولية/التهيئة.
