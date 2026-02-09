---
summary: "اكتشاف Bonjour/mDNS + تصحيح الأخطاء (إشارات Gateway، العملاء، وأنماط الفشل الشائعة)"
read_when:
  - تصحيح مشكلات اكتشاف Bonjour على macOS/iOS
  - تغيير أنواع خدمات mDNS أو سجلات TXT أو تجربة واجهة الاكتشاف
title: "اكتشاف Bonjour"
---

# اكتشاف Bonjour / mDNS

يستخدم OpenClaw ‏Bonjour ‏(mDNS / DNS‑SD) كوسيلة **مريحة ضمن الشبكة المحلية فقط** لاكتشاف
Gateway نشطة (نقطة نهاية WebSocket). يعمل ذلك بأفضل جهد ممكن ولا **يستبدل** الاتصال عبر SSH أو
الاتصال القائم على Tailnet.

## Bonjour واسع النطاق (Unicast DNS‑SD) عبر Tailscale

إذا كانت العُقدة وGateway على شبكتين مختلفتين، فلن يعبر mDNS متعدد الإرسال
الحدود. يمكنك الحفاظ على تجربة الاكتشاف نفسها عبر التحويل إلى **Unicast DNS‑SD**
(«Bonjour واسع النطاق») فوق Tailscale.

الخطوات عالية المستوى:

1. تشغيل خادم DNS على مضيف Gateway (يمكن الوصول إليه عبر Tailnet).
2. نشر سجلات DNS‑SD لـ `_openclaw-gw._tcp` ضمن نطاق مخصص
   (مثال: `openclaw.internal.`).
3. تهيئة **split DNS** في Tailscale بحيث يُحلّ نطاقك المختار عبر ذلك
   الخادم لجهة العملاء (بما في ذلك iOS).

يدعم OpenClaw أي نطاق اكتشاف؛ ‏`openclaw.internal.` مجرد مثال.
تستعرض عُقد iOS/Android كِلَا `local.` ونطاقك واسع النطاق المُهيّأ.

### تهيئة Gateway (موصى بها)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### إعداد خادم DNS لمرة واحدة (مضيف Gateway)

```bash
openclaw dns setup --apply
```

يؤدي ذلك إلى تثبيت CoreDNS وتهيئته ليقوم بما يلي:

- الاستماع على المنفذ 53 فقط على واجهات Tailscale الخاصة بـ Gateway
- خدمة نطاقك المختار (مثال: `openclaw.internal.`) من `~/.openclaw/dns/<domain>.db`

تحقق من جهاز متصل بـ tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### إعدادات DNS في Tailscale

في وحدة تحكم إدارة Tailscale:

- أضف خادم أسماء يشير إلى عنوان IP الخاص بـ tailnet لـ Gateway (‏UDP/TCP 53).
- أضف split DNS بحيث يستخدم نطاق الاكتشاف خادم الأسماء هذا.

بمجرد قبول العملاء لـ DNS الخاص بـ tailnet، يمكن لعُقد iOS استعراض
`_openclaw-gw._tcp` ضمن نطاق الاكتشاف دون تعدد الإرسال.

### أمان مستمع Gateway (موصى به)

يرتبط منفذ WS الخاص بـ Gateway (الافتراضي `18789`) على loopback افتراضيًا. للوصول عبر LAN/tailnet،
اربطه صراحةً مع الإبقاء على المصادقة مُمكّنة.

لإعدادات tailnet فقط:

- عيّن `gateway.bind: "tailnet"` في `~/.openclaw/openclaw.json`.
- أعد تشغيل Gateway (أو أعد تشغيل تطبيق شريط القوائم على macOS).

## ما الذي يعلن

تعلن Gateway فقط عن `_openclaw-gw._tcp`.

## أنواع الخدمات

- `_openclaw-gw._tcp` — إشارة نقل Gateway (تستخدمها عُقد macOS/iOS/Android).

## مفاتيح TXT (تلميحات غير سرية)

تعلن Gateway عن تلميحات صغيرة غير سرية لتسهيل تدفقات واجهة المستخدم:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (فقط عند تمكين TLS)
- `gatewayTlsSha256=<sha256>` (فقط عند تمكين TLS وتوفر البصمة)
- `canvasPort=<port>` (فقط عند تمكين مضيف اللوحة؛ الافتراضي `18793`)
- `sshPort=<port>` (الافتراضي 22 عند عدم التجاوز)
- `transport=gateway`
- `cliPath=<path>` (اختياري؛ مسار مطلق لنقطة دخول قابلة للتشغيل `openclaw`)
- `tailnetDns=<magicdns>` (تلميح اختياري عند توفر Tailnet)

## تصحيح الأخطاء على macOS

أدوات مدمجة مفيدة:

- حالات التصفح:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- حلّ مثيل واحد (استبدل `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

إذا نجح الاستعراض لكن فشل الحلّ، فعادةً ما تكون المشكلة سياسة LAN أو
مُحلِّل mDNS.

## تصحيح الأخطاء في سجلات Gateway

تكتب Gateway ملف سجل دوّار (يُطبع عند بدء التشغيل باسم
`gateway log file: ...`). ابحث عن أسطر `bonjour:`، خصوصًا:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## تصحيح الأخطاء على عُقدة iOS

تستخدم عُقدة iOS ‏`NWBrowser` لاكتشاف `_openclaw-gw._tcp`.

لالتقاط السجلات:

- الإعدادات → Gateway → متقدم → **سجلات تصحيح اكتشاف**
- الإعدادات → Gateway → متقدم → **سجلات الاكتشاف** → أعد الإنتاج → **نسخ**

يتضمن السجل انتقالات حالة المتصفح وتغييرات مجموعة النتائج.

## أنماط الفشل الشائعة

- **Bonjour لا يعبر الشبكات**: استخدم Tailnet أو SSH.
- **تعدد الإرسال محجوب**: بعض شبكات Wi‑Fi تعطل mDNS.
- **النوم / تبدّل الواجهات**: قد يسقط macOS نتائج mDNS مؤقتًا؛ أعد المحاولة.
- **الاستعراض يعمل لكن الحلّ يفشل**: أبقِ أسماء الأجهزة بسيطة (تجنب الرموز التعبيرية أو
  علامات الترقيم)، ثم أعد تشغيل Gateway. اسم مثيل الخدمة مشتق من
  اسم المضيف، لذا قد تُربك الأسماء المعقدة بعض المُحلِّلات.

## أسماء المثيلات المُفلتة (`\032`)

غالبًا ما يفلت Bonjour/DNS‑SD البايتات في أسماء مثيلات الخدمة كسلاسل عشرية `\DDD`
(مثل تحوّل المسافات إلى `\032`).

- هذا طبيعي على مستوى البروتوكول.
- يجب على واجهات المستخدم فك الترميز للعرض (يستخدم iOS ‏`BonjourEscapes.decode`).

## التعطيل / التهيئة

- `OPENCLAW_DISABLE_BONJOUR=1` يعطّل الإعلان (القديم: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` في `~/.openclaw/openclaw.json` يتحكم في وضع ربط Gateway.
- `OPENCLAW_SSH_PORT` يتجاوز منفذ SSH المُعلن في TXT (القديم: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` ينشر تلميح MagicDNS في TXT (القديم: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` يتجاوز مسار CLI المُعلن (القديم: `OPENCLAW_CLI_PATH`).

## مستندات ذات صلة

- سياسة الاكتشاف واختيار النقل: [Discovery](/gateway/discovery)
- إقران العُقد + الموافقات: [Gateway pairing](/gateway/pairing)
