---
summary: "تشغيلات مباشرة لأمر `openclaw agent` عبر CLI (مع تسليم اختياري)"
read_when:
  - إضافة أو تعديل نقطة دخول CLI للوكيل
title: "إرسال الوكيل"
---

# `openclaw agent` (تشغيلات مباشرة للوكيل)

تشغّل `openclaw agent` دورًا واحدًا للوكيل دون الحاجة إلى رسالة دردشة واردة.
افتراضيًا يمر **عبر Gateway (البوابة)**؛ أضِف `--local` لفرض استخدام
وقت التشغيل المُضمَّن على الجهاز الحالي.

## السلوك

- مطلوب: `--message <text>`
- اختيار الجلسة:
  - `--to <dest>` يستنتج مفتاح الجلسة (تحافظ أهداف المجموعات/القنوات على العزل؛ وتنهار الدردشات المباشرة إلى `main`)، **أو**
  - `--session-id <id>` يعيد استخدام جلسة موجودة حسب المعرّف، **أو**
  - `--agent <id>` يستهدف وكيلًا مُهيّأً مباشرة (يستخدم مفتاح جلسة `main` الخاص بذلك الوكيل)
- يشغّل نفس وقت تشغيل الوكيل المُضمَّن كما في الردود الواردة العادية.
- تستمر أعلام التفكير/التفصيل في مخزن الجلسة.
- الإخراج:
  - الافتراضي: يطبع نص الرد (بالإضافة إلى أسطر `MEDIA:<url>`)
  - `--json`: يطبع حمولة مُهيكلة + بيانات وصفية
- تسليم اختياري إلى قناة باستخدام `--deliver` + `--channel` (تطابق صيغ الأهداف `openclaw message --target`).
- استخدم `--reply-channel`/`--reply-to`/`--reply-account` لتجاوز التسليم دون تغيير الجلسة.

إذا تعذّر الوصول إلى Gateway، فإن CLI **يعود** إلى التشغيل المحلي المُضمَّن.

## أمثلة

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## الأعلام

- `--local`: تشغيل محليًا (يتطلب مفاتيح واجهة برمجة تطبيقات موفّر النموذج في جلسة الصدفة لديك)
- `--deliver`: إرسال الرد إلى القناة المختارة
- `--channel`: قناة التسليم (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`، الافتراضي: `whatsapp`)
- `--reply-to`: تجاوز هدف التسليم
- `--reply-channel`: تجاوز قناة التسليم
- `--reply-account`: تجاوز معرّف حساب التسليم
- `--thinking <off|minimal|low|medium|high|xhigh>`: تثبيت مستوى التفكير (نماذج GPT-5.2 + Codex فقط)
- `--verbose <on|full|off>`: تثبيت مستوى التفصيل
- `--timeout <seconds>`: تجاوز مهلة الوكيل
- `--json`: إخراج JSON مُهيكل
