---
summary: "بروتوكول Gateway عبر WebSocket: المصافحة، الإطارات، وإدارة الإصدارات"
read_when:
  - تنفيذ أو تحديث عملاء WS لـ Gateway
  - استكشاف عدم تطابق البروتوكول أو أعطال الاتصال وإصلاحها
  - إعادة توليد مخططات/نماذج البروتوكول
title: "بروتوكول Gateway"
---

# بروتوكول Gateway (WebSocket)

بروتوكول WS الخاص بـ Gateway هو **مستوى التحكم الواحد + نقل العُقد** لـ
OpenClaw. جميع العملاء (CLI، واجهة الويب، تطبيق macOS، عُقد iOS/Android، العُقد
بدون واجهة) يتصلون عبر WebSocket ويُعلنون **الدور** + **النطاق** عند
وقت المصافحة.

## النقل

- WebSocket، إطارات نصية بحمولات JSON.
- يجب أن يكون الإطار الأول **حتماً** طلب `connect`.

## المصافحة (الاتصال)

Gateway → العميل (تحدّي ما قبل الاتصال):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

العميل → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → العميل:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

عند إصدار رمز جهاز، يتضمن `hello-ok` أيضًا:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### مثال عُقدة

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## إطارات

- **طلب**: `{type:"req", id, method, params}`
- **استجابة**: `{type:"res", id, ok, payload|error}`
- **حدث**: `{type:"event", event, payload, seq?, stateVersion?}`

الأساليب ذات الآثار الجانبية تتطلب **مفاتيح عدم التكرار** (انظر المخطط).

## الأدوار + النطاقات

### الأدوار

- `operator` = عميل مستوى التحكم (CLI/واجهة مستخدم/أتمتة).
- `node` = مضيف قدرات (كاميرا/شاشة/لوحة/‏system.run).

### النطاقات (المشغل)

نطاقات شائعة:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### القدرات/الأوامر/الأذونات (العُقدة)

تُعلن العُقد مطالبات القدرات عند وقت الاتصال:

- `caps`: فئات القدرات عالية المستوى.
- `commands`: قائمة السماح للأوامر القابلة للاستدعاء.
- `permissions`: مفاتيح تبديل دقيقة (مثل `screen.record`، `camera.capture`).

يتعامل Gateway مع هذه على أنها **مطالبات** ويُطبّق قوائم السماح على جانب الخادم.

## الحضور

- `system-presence` يعيد إدخالات مفهرسة بهوية الجهاز.
- تتضمن إدخالات الحضور `deviceId`، `roles`، و `scopes` بحيث يمكن لواجهات المستخدم عرض صف واحد لكل جهاز
  حتى عندما يتصل بدوري **المشغّل** و**العُقدة**.

### أساليب مساعدة للعُقد

- يمكن للعُقد استدعاء `skills.bins` لجلب القائمة الحالية لملفات Skills التنفيذية
  للتحقق التلقائي من السماح.

## موافقات التنفيذ

- عندما يتطلب طلب التنفيذ موافقة، يقوم Gateway ببث `exec.approval.requested`.
- تحسم عملاء المشغّل ذلك عبر استدعاء `exec.approval.resolve` (يتطلب نطاق `operator.approvals`).

## الإصدارات

- `PROTOCOL_VERSION` موجود في `src/gateway/protocol/schema.ts`.
- يرسل العملاء `minProtocol` + `maxProtocol`؛ ويرفض الخادم عدم التطابق.
- تُولَّد المخططات + النماذج من تعريفات TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## المصادقة

- إذا تم تعيين `OPENCLAW_GATEWAY_TOKEN` (أو `--token`)، فيجب أن يتطابق `connect.params.auth.token`
  وإلا يُغلَق المقبس.
- بعد الإقران، يُصدر Gateway **رمز جهاز** مضبوطًا على
  دور الاتصال + النطاقات. ويُعاد في `hello-ok.auth.deviceToken` ويجب
  على العميل حفظه للاتصالات المستقبلية.
- يمكن تدوير/إبطال رموز الأجهزة عبر `device.token.rotate` و
  `device.token.revoke` (يتطلب نطاق `operator.pairing`).

## هوية الجهاز + الإقران

- ينبغي أن تتضمن العُقد هوية جهاز مستقرة (`device.id`) مشتقة من
  بصمة زوج مفاتيح.
- تُصدر Gateways رموزًا لكل جهاز + دور.
- تتطلب معرفات الأجهزة الجديدة موافقات إقران ما لم يكن الاعتماد التلقائي المحلي
  مُمكّنًا.
- تتضمن الاتصالات **المحلية** loopback وعنوان tailnet الخاص بمضيف Gateway نفسه
  (بحيث يمكن لارتباطات tailnet على نفس المضيف أن تعتمد تلقائيًا).
- يجب على جميع عملاء WS تضمين هوية `device` أثناء `connect` (المشغّل + العُقدة).
  يمكن لواجهة التحكم إغفالها **فقط** عندما يكون `gateway.controlUi.allowInsecureAuth` مُمكّنًا
  (أو `gateway.controlUi.dangerouslyDisableDeviceAuth` لاستخدام «كسر الزجاج»).
- يجب على الاتصالات غير المحلية توقيع nonce الموفَّر من الخادم `connect.challenge`.

## TLS + التثبيت

- يدعم TLS اتصالات WS.
- يمكن للعملاء اختياريًا تثبيت بصمة شهادة Gateway (انظر تهيئة `gateway.tls`
  إضافةً إلى `gateway.remote.tlsFingerprint` أو CLI `--tls-fingerprint`).

## النطاق

يكشف هذا البروتوكول **واجهة برمجة التطبيقات الكاملة لـ Gateway** (الحالة، القنوات، النماذج، الدردشة،
الوكيل، الجلسات، العُقد، الموافقات، إلخ). ويُعرَّف السطح الدقيق بواسطة
مخططات TypeBox في `src/gateway/protocol/schema.ts`.
