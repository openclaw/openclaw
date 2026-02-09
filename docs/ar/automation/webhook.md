---
summary: "إدخال Webhook للإيقاظ وتشغيل الوكلاء المعزولين"
read_when:
  - إضافة أو تغيير نقاط نهاية Webhook
  - ربط الأنظمة الخارجية بـ OpenClaw
title: "Webhooks"
---

# Webhooks

يمكن لـ Gateway (البوابة) كشف نقطة نهاية HTTP Webhook صغيرة للمحفزات الخارجية.

## التمكين

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

ملاحظات:

- `hooks.token` مطلوب عند `hooks.enabled=true`.
- `hooks.path` افتراضيًا إلى `/hooks`.

## المصادقة

يجب أن يتضمن كل طلب رمز الـ hook. يُفضَّل استخدام الرؤوس:

- `Authorization: Bearer <token>` (موصى به)
- `x-openclaw-token: <token>`
- `?token=<token>` (مهمَل؛ يسجّل تحذيرًا وسيُزال في إصدار رئيسي مستقبلي)

## نقاط النهاية

### `POST /hooks/wake`

الحمولة:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **مطلوب** (string): وصف الحدث (مثل «تم استلام بريد إلكتروني جديد»).
- `mode` اختياري (`now` | `next-heartbeat`): ما إذا كان سيتم تشغيل نبضة فورية (الافتراضي `now`) أو الانتظار حتى الفحص الدوري التالي.

الأثر:

- إضافة حدث نظام إلى جلسة **main**
- إذا كان `mode=now`، يتم تشغيل نبضة فورية

### `POST /hooks/agent`

الحمولة:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **مطلوب** (string): الموجّه أو الرسالة التي سيعالجها الوكيل.
- `name` اختياري (string): اسم مقروء للبشر للـ hook (مثل «GitHub»)، يُستخدم كبادئة في ملخصات الجلسة.
- `sessionKey` اختياري (string): المفتاح المستخدم لتعريف جلسة الوكيل. افتراضيًا قيمة `hook:<uuid>` عشوائية. يتيح استخدام مفتاح ثابت إجراء محادثة متعددة الأدوار ضمن سياق الـ hook.
- `wakeMode` اختياري (`now` | `next-heartbeat`): ما إذا كان سيتم تشغيل نبضة فورية (الافتراضي `now`) أو الانتظار حتى الفحص الدوري التالي.
- `deliver` اختياري (boolean): إذا كان `true`، فسيتم إرسال استجابة الوكيل إلى قناة المراسلة. الافتراضي `true`. يتم تخطي الاستجابات التي تكون مجرد إقرارات نبضة تلقائيًا.
- `channel` اختياري (string): قناة المراسلة للتسليم. واحدة من: `last`، `whatsapp`، `telegram`، `discord`، `slack`، `mattermost` (plugin)، `signal`، `imessage`، `msteams`. الافتراضي `last`.
- `to` اختياري (string): مُعرِّف المستلِم للقناة (مثل رقم الهاتف لـ WhatsApp/Signal، ومعرّف الدردشة لـ Telegram، ومعرّف القناة لـ Discord/Slack/Mattermost (plugin)، ومعرّف المحادثة لـ Microsoft Teams). الافتراضي هو آخر مستلِم في جلسة main.
- `model` اختياري (string): تجاوز النموذج (مثل `anthropic/claude-3-5-sonnet` أو اسم مستعار). يجب أن يكون ضمن قائمة النماذج المسموح بها إذا كانت مقيّدة.
- `thinking` اختياري (string): تجاوز مستوى التفكير (مثل `low`، `medium`، `high`).
- `timeoutSeconds` اختياري (number): المدة القصوى لتشغيل الوكيل بالثواني.

الأثر:

- تشغيل دور وكيل **معزول** (بمفتاح جلسة خاص)
- نشر ملخص دائمًا في جلسة **main**
- إذا كان `wakeMode=now`، يتم تشغيل نبضة فورية

### `POST /hooks/<name>` (مُعيَّن)

تُحل أسماء الـ hook المخصصة عبر `hooks.mappings` (انظر التهيئة). يمكن للتعيين
تحويل الحمولات التعسفية إلى إجراءات `wake` أو `agent`، مع قوالب اختيارية أو
تحويلات برمجية.

خيارات التعيين (ملخص):

- `hooks.presets: ["gmail"]` يفعّل تعيين Gmail المضمّن.
- `hooks.mappings` يتيح لك تعريف `match` و`action` والقوالب في التهيئة.
- `hooks.transformsDir` + `transform.module` لتحميل وحدة JS/TS لمنطق مخصص.
- استخدم `match.source` للإبقاء على نقطة إدخال عامة (توجيه قائم على الحمولة).
- تتطلب تحويلات TS مُحمِّل TS (مثل `bun` أو `tsx`) أو `.js` مُسبقة التجميع وقت التشغيل.
- عيّن `deliver: true` + `channel`/`to` على التعيينات لتوجيه الردود إلى واجهة دردشة
  (`channel` افتراضيًا إلى `last` ويعود إلى WhatsApp).
- `allowUnsafeExternalContent: true` يعطّل غلاف سلامة المحتوى الخارجي لذلك الـ hook
  (خطر؛ للاستخدام فقط مع مصادر داخلية موثوقة).
- `openclaw webhooks gmail setup` يكتب تهيئة `hooks.gmail` لـ `openclaw webhooks gmail run`.
  راجع [Gmail Pub/Sub](/automation/gmail-pubsub) لسير عمل مراقبة Gmail الكامل.

## الاستجابات

- `200` لـ `/hooks/wake`
- `202` لـ `/hooks/agent` (بدء تشغيل غير متزامن)
- `401` عند فشل المصادقة
- `400` عند حمولة غير صالحة
- `413` عند الحمولات كبيرة الحجم

## أمثلة

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### استخدام نموذج مختلف

أضف `model` إلى حمولة الوكيل (أو التعيين) لتجاوز النموذج لهذا التشغيل:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

إذا كنت تفرض `agents.defaults.models`، فتأكد من تضمين نموذج التجاوز هناك.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## الأمان

- أبقِ نقاط نهاية الـ hook خلف loopback أو tailnet أو وكيل عكسي موثوق.
- استخدم رمز hook مخصصًا؛ لا تعِد استخدام رموز مصادقة Gateway.
- تجنّب تضمين حمولات خام حساسة في سجلات الـ webhook.
- تُعامَل حمولات الـ hook على أنها غير موثوقة وتُغلَّف بحدود أمان افتراضيًا.
  إذا اضطررت لتعطيل ذلك لـ hook معيّن، فاضبط `allowUnsafeExternalContent: true`
  في تعيين ذلك الـ hook (خطر).
