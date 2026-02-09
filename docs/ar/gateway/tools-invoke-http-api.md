---
summary: "استدعاء أداة واحدة مباشرة عبر نقطة نهاية Gateway ‏HTTP"
read_when:
  - استدعاء الأدوات دون تشغيل دورة وكيل كاملة
  - بناء أتمتة تتطلب فرض سياسات الأدوات
title: "واجهة برمجة تطبيقات استدعاء الأدوات"
---

# استدعاء الأدوات (HTTP)

تُوفّر Gateway في OpenClaw نقطة نهاية HTTP بسيطة لاستدعاء أداة واحدة مباشرة. تكون مُمكّنة دائمًا، لكنها مقيّدة بمصادقة Gateway وسياسة الأدوات.

- `POST /tools/invoke`
- نفس المنفذ المستخدم لـ Gateway (تعدد WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

الحد الأقصى الافتراضي لحجم الحمولة هو 2 ميغابايت.

## المصادقة

تستخدم تهيئة مصادقة Gateway. أرسل رمز Bearer:

- `Authorization: Bearer <token>`

ملاحظات:

- عند `gateway.auth.mode="token"`، استخدم `gateway.auth.token` (أو `OPENCLAW_GATEWAY_TOKEN`).
- عند `gateway.auth.mode="password"`، استخدم `gateway.auth.password` (أو `OPENCLAW_GATEWAY_PASSWORD`).

## طلب الجسم

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

الحقول:

- `tool` (string، مطلوب): اسم الأداة المراد استدعاؤها.
- `action` (string، اختياري): يُدرج في args إذا كان مخطط الأداة يدعم `action` ولم تتضمن حمولة args هذا الحقل.
- `args` (object، اختياري): وسائط خاصة بالأداة.
- `sessionKey` (string، اختياري): مفتاح الجلسة الهدف. إذا تم إهماله أو كان `"main"`، تستخدم Gateway مفتاح الجلسة الرئيسي المُهيّأ (مع احترام `session.mainKey` والوكيل الافتراضي، أو `global` في النطاق العام).
- `dryRun` (boolean، اختياري): محجوز للاستخدام المستقبلي؛ يتم تجاهله حاليًا.

## السلوك الخاص بالسياسات والتوجيه

تُرشَّح إتاحة الأدوات عبر سلسلة السياسات نفسها المستخدمة بواسطة وكلاء Gateway:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- سياسات المجموعات (إذا كان مفتاح الجلسة يطابق مجموعة أو قناة)
- سياسة الوكيل الفرعي (عند الاستدعاء باستخدام مفتاح جلسة وكيل فرعي)

إذا لم يُسمح بالأداة وفق السياسة، تُعيد نقطة النهاية الرمز **404**.

لمساعدة سياسات المجموعات على حلّ السياق، يمكنك اختياريًا تعيين:

- `x-openclaw-message-channel: <channel>` (مثال: `slack`، `telegram`)
- `x-openclaw-account-id: <accountId>` (عند وجود حسابات متعددة)

## الاستجابات

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (طلب غير صالح أو خطأ في الأداة)
- `401` → غير مُصرّح
- `404` → الأداة غير متاحة (غير موجودة أو غير مُدرجة في قائمة السماح)
- `405` → الطريقة غير مسموح بها

## مثال

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
