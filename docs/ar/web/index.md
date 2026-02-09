---
summary: "واجهات الويب الخاصة بـ Gateway: واجهة التحكم، أوضاع الربط، والأمان"
read_when:
  - تريد الوصول إلى Gateway عبر Tailscale
  - تريد واجهة التحكم في المتصفح وتحرير التهيئة
title: "الويب"
---

# الويب (Gateway)

يقدّم Gateway **واجهة تحكم في المتصفح** صغيرة (Vite + Lit) من نفس المنفذ الذي يستخدمه WebSocket الخاص بـ Gateway:

- الافتراضي: `http://<host>:18789/`
- بادئة اختيارية: عيّن `gateway.controlUi.basePath` (مثلًا `/openclaw`)

توجد القدرات في [واجهة التحكم](/web/control-ui).
تركّز هذه الصفحة على أوضاع الربط، والأمان، والأسطح الموجّهة للويب.

## Webhooks

عند `hooks.enabled=true`، يوفّر Gateway أيضًا نقطة نهاية webhook صغيرة على نفس خادم HTTP.
راجع [تهيئة Gateway](/gateway/configuration) → `hooks` للمصادقة والحمولات.

## التهيئة (مفعّلة افتراضيًا)

تكون واجهة التحكم **مفعّلة افتراضيًا** عند توفّر الأصول (`dist/control-ui`).
يمكنك التحكم بها عبر التهيئة:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## الوصول عبر Tailscale

### Serve المتكامل (موصى به)

أبقِ Gateway على local loopback ودع Tailscale Serve يعمل كوكيل:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

ثم شغّل Gateway:

```bash
openclaw gateway
```

افتح:

- `https://<magicdns>/` (أو `gateway.controlUi.basePath` الذي قمت بتهيئته)

### الربط على Tailnet + رمز مميّز

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

ثم شغّل Gateway (الرمز المميّز مطلوب لعمليات الربط غير المحلية):

```bash
openclaw gateway
```

افتح:

- `http://<tailscale-ip>:18789/` (أو `gateway.controlUi.basePath` الذي قمت بتهيئته)

### الإنترنت العام (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## ملاحظات الأمان

- المصادقة على Gateway مطلوبة افتراضيًا (رمز مميّز/كلمة مرور أو رؤوس هوية Tailscale).
- عمليات الربط غير المحلية **تتطلّب** رمزًا/كلمة مرور مشتركة (`gateway.auth` أو متغيرات البيئة).
- يقوم معالج الإعداد بإنشاء رمز Gateway افتراضيًا (حتى على local loopback).
- ترسل الواجهة `connect.params.auth.token` أو `connect.params.auth.password`.
- ترسل واجهة التحكم رؤوسًا مضادّة للنقر الاحتيالي (anti-clickjacking) ولا تقبل
  اتصالات WebSocket من المتصفح إلا من نفس الأصل، ما لم يتم تعيين `gateway.controlUi.allowedOrigins`.
- مع Serve، يمكن لرؤوس هوية Tailscale تلبية متطلبات المصادقة عندما يكون
  `gateway.auth.allowTailscale` هو `true` (لا يلزم رمز/كلمة مرور). عيّن
  `gateway.auth.allowTailscale: false` لطلب بيانات اعتماد صريحة. راجع
  [Tailscale](/gateway/tailscale) و[الأمان](/gateway/security).
- يتطلّب `gateway.tailscale.mode: "funnel"` وجود `gateway.auth.mode: "password"` (كلمة مرور مشتركة).

## بناء الواجهة

يقدّم Gateway الملفات الثابتة من `dist/control-ui`. ابنِها باستخدام:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
