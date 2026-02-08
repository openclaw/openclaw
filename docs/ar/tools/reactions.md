---
summary: "دلالات التفاعلات المشتركة عبر القنوات"
read_when:
  - "العمل على التفاعلات في أي قناة"
title: "التفاعلات"
x-i18n:
  source_path: tools/reactions.md
  source_hash: 0f11bff9adb4bd02
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:42Z
---

# أدوات التفاعلات

دلالات تفاعلات مشتركة عبر القنوات:

- `emoji` مطلوب عند إضافة تفاعل.
- `emoji=""` يزيل تفاعل/تفاعلات البوت عند الدعم.
- `remove: true` يزيل الإيموجي المحدد عند الدعم (يتطلب `emoji`).

ملاحظات القنوات:

- **Discord/Slack**: قيمة `emoji` الفارغة تزيل جميع تفاعلات البوت على الرسالة؛ بينما `remove: true` يزيل ذلك الإيموجي فقط.
- **Google Chat**: قيمة `emoji` الفارغة تزيل تفاعلات التطبيق على الرسالة؛ بينما `remove: true` يزيل ذلك الإيموجي فقط.
- **Telegram**: قيمة `emoji` الفارغة تزيل تفاعلات البوت؛ كما أن `remove: true` يزيل التفاعلات أيضًا لكنه لا يزال يتطلب قيمة غير فارغة لـ `emoji` للتحقق من صحة الأداة.
- **WhatsApp**: قيمة `emoji` الفارغة تزيل تفاعل البوت؛ و `remove: true` تُطابِق إيموجي فارغًا (ولا يزال يتطلب `emoji`).
- **Signal**: إشعارات التفاعل الواردة تُصدر أحداث نظام عند تمكين `channels.signal.reactionNotifications`.
