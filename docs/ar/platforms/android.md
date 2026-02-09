---
summary: "تطبيق Android (عُقدة): دليل تشغيل الاتصال + Canvas/الدردشة/الكاميرا"
read_when:
  - إقران عُقدة Android أو إعادة الاتصال بها
  - تصحيح اكتشاف Gateway أو المصادقة على Android
  - التحقق من تطابق سجل الدردشة عبر العملاء
title: "تطبيق Android"
---

# تطبيق Android (عُقدة)

## لمحة عن الدعم

- الدور: تطبيق عُقدة مُرافِقة (Android لا يستضيف Gateway).
- يتطلب Gateway: نعم (شغّله على macOS أو Linux أو Windows عبر WSL2).
- التثبيت: [بدء الاستخدام](/start/getting-started) + [الإقران](/gateway/pairing).
- Gateway: [دليل التشغيل](/gateway) + [التهيئة](/gateway/configuration).
  - البروتوكولات: [بروتوكول Gateway](/gateway/protocol) (العُقد + طبقة التحكم).

## التحكم بالنظام

التحكم بالنظام (launchd/systemd) موجود على مضيف Gateway. راجع [Gateway](/gateway).

## دليل تشغيل الاتصال

تطبيق عُقدة Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

يتصل Android مباشرةً بـ WebSocket الخاص بـ Gateway (الافتراضي `ws://<host>:18789`) ويستخدم إقرانًا مملوكًا لـ Gateway.

### المتطلبات المسبقة

- يمكنك تشغيل Gateway على الجهاز «الرئيسي».
- يمكن لجهاز/محاكي Android الوصول إلى WebSocket الخاص بـ Gateway:
  - نفس الشبكة المحلية مع mDNS/NSD، **أو**
  - نفس شبكة Tailscale باستخدام Wide-Area Bonjour / unicast DNS-SD (انظر أدناه)، **أو**
  - مضيف/منفذ Gateway يدويًا (حل احتياطي)
- يمكنك تشغيل CLI (`openclaw`) على جهاز Gateway (أو عبر SSH).

### 1. تشغيل Gateway

```bash
openclaw gateway --port 18789 --verbose
```

تأكد في السجلات من ظهور شيء مثل:

- `listening on ws://0.0.0.0:18789`

لإعدادات شبكة tailnet فقط (موصى بها لفيينا ⇄ لندن)، اربط Gateway بعنوان IP الخاص بالـ tailnet:

- عيّن `gateway.bind: "tailnet"` في `~/.openclaw/openclaw.json` على مضيف Gateway.
- أعد تشغيل Gateway / تطبيق شريط القوائم على macOS.

### 2. التحقق من الاكتشاف (اختياري)

من جهاز Gateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

ملاحظات إضافية للتصحيح: [Bonjour](/gateway/bonjour).

#### اكتشاف Tailnet (فيينا ⇄ لندن) عبر unicast DNS-SD

لن يعبر اكتشاف NSD/mDNS على Android الشبكات. إذا كانت عُقدة Android وGateway على شبكتين مختلفتين لكنهما متصلتان عبر Tailscale، فاستخدم Wide-Area Bonjour / unicast DNS-SD بدلًا من ذلك:

1. أنشئ نطاق DNS-SD (مثال `openclaw.internal.`) على مضيف Gateway وانشر سجلات `_openclaw-gw._tcp`.
2. اضبط split DNS في Tailscale لنطاقك المختار ليشير إلى خادم DNS هذا.

التفاصيل ومثال تهيئة CoreDNS: [Bonjour](/gateway/bonjour).

### 3. الاتصال من Android

في تطبيق Android:

- يحافظ التطبيق على اتصال Gateway عبر **خدمة في المقدمة** (إشعار دائم).
- افتح **الإعدادات**.
- ضمن **Gateways المكتشفة**، اختر Gateway واضغط **اتصال**.
- إذا كان mDNS محظورًا، استخدم **متقدم → Gateway يدوي** (المضيف + المنفذ) ثم **اتصال (يدوي)**.

بعد أول إقران ناجح، يعاود Android الاتصال تلقائيًا عند التشغيل:

- نقطة نهاية يدوية (إن كانت مفعّلة)، وإلا
- آخر Gateway تم اكتشافه (بأفضل جهد).

### 4. اعتماد الإقران (CLI)

على جهاز Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

تفاصيل الإقران: [إقران Gateway](/gateway/pairing).

### 5. التحقق من اتصال العُقدة

- عبر حالة العُقد:

  ```bash
  openclaw nodes status
  ```

- عبر Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. الدردشة + السجل

تستخدم ورقة الدردشة في عُقدة Android **مفتاح الجلسة الأساسية** الخاص بـ Gateway (`main`)، لذلك تتم مشاركة السجل والردود مع WebChat والعملاء الآخرين:

- السجل: `chat.history`
- الإرسال: `chat.send`
- تحديثات الدفع (بأفضل جهد): `chat.subscribe` → `event:"chat"`

### 7. Canvas + الكاميرا

#### مضيف Canvas في Gateway (موصى به لمحتوى الويب)

إذا أردت أن تعرض العُقدة HTML/CSS/JS حقيقيًا يمكن للوكيل تعديله على القرص، فوجّه العُقدة إلى مضيف Canvas في Gateway.

ملاحظة: تستخدم العُقد مضيف Canvas المستقل على `canvasHost.port` (الافتراضي `18793`).

1. أنشئ `~/.openclaw/workspace/canvas/index.html` على مضيف Gateway.

2. انتقل بالعُقدة إليه (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (اختياري): إذا كان الجهازان على Tailscale، استخدم اسم MagicDNS أو عنوان IP للـ tailnet بدلًا من `.local`، مثل `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

يقوم هذا الخادم بحقن عميل إعادة تحميل مباشر في HTML ويعيد التحميل عند تغيّر الملفات.
يقع مضيف A2UI على `http://<gateway-host>:18793/__openclaw__/a2ui/`.

أوامر Canvas (في المقدمة فقط):

- `canvas.eval`، `canvas.snapshot`، `canvas.navigate` (استخدم `{"url":""}` أو `{"url":"/"}` للعودة إلى الهيكل الافتراضي). يُعيد `canvas.snapshot` `{ format, base64 }` (الافتراضي `format="jpeg"`).
- A2UI: `canvas.a2ui.push`، `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` اسم مستعار قديم)

أوامر الكاميرا (في المقدمة فقط؛ تتطلب إذنًا):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

راجع [عُقدة الكاميرا](/nodes/camera) للاطلاع على المعلمات ومساعدات CLI.
