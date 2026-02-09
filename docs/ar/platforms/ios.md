---
summary: "تطبيق عُقدة iOS: الاتصال بـ Gateway، الاقتران، اللوحة، واستكشاف الأخطاء وإصلاحها"
read_when:
  - إقران أو إعادة توصيل عُقدة iOS
  - تشغيل تطبيق iOS من الشيفرة المصدرية
  - تصحيح اكتشاف Gateway أو أوامر اللوحة
title: "تطبيق iOS"
---

# تطبيق iOS (عُقدة)

التوفّر: معاينة داخلية. لم يتم توزيع تطبيق iOS للعامة بعد.

## ما الذي يفعله

- يتصل بـ Gateway عبر WebSocket (شبكة محلية LAN أو tailnet).
- يعرّض قدرات العُقدة: اللوحة (Canvas)، لقطة الشاشة، التقاط الكاميرا، الموقع، وضع التحدث، الاستيقاظ الصوتي.
- يستقبل أوامر `node.invoke` ويبلّغ عن أحداث حالة العُقدة.

## المتطلبات

- تشغيل Gateway على جهاز آخر (macOS أو Linux أو Windows عبر WSL2).
- مسار الشبكة:
  - نفس شبكة LAN عبر Bonjour، **أو**
  - عبر tailnet باستخدام unicast DNS-SD (نطاق مثال: `openclaw.internal.`)، **أو**
  - إدخال المضيف/المنفذ يدويًا (حل احتياطي).

## البدء السريع (إقران + اتصال)

1. ابدأ Gateway:

```bash
openclaw gateway --port 18789
```

2. في تطبيق iOS، افتح الإعدادات واختر Gateway مكتشفة (أو فعّل «Manual Host» وأدخل المضيف/المنفذ).

3. وافق على طلب الإقران على مضيف Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. التحقق من الاتصال:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## مسارات الاكتشاف

### Bonjour (LAN)

يعلن Gateway عن `_openclaw-gw._tcp` على `local.`. يعرض تطبيق iOS هذه العناصر تلقائيًا.

### Tailnet (عبر الشبكات)

إذا كان mDNS محظورًا، استخدم منطقة unicast DNS-SD (اختر نطاقًا؛ مثال: `openclaw.internal.`) وتقسيم DNS في Tailscale.
انظر [Bonjour](/gateway/bonjour) لمثال CoreDNS.

### المضيف/المنفذ اليدوي

في الإعدادات، فعّل **Manual Host** وأدخل مضيف Gateway + المنفذ (الافتراضي `18789`).

## اللوحة (Canvas) + A2UI

تعرض عُقدة iOS لوحة WKWebView. استخدم `node.invoke` للتحكم بها:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

ملاحظات:

- يقدّم مضيف لوحة Gateway `/__openclaw__/canvas/` و`/__openclaw__/a2ui/`.
- تنتقل عُقدة iOS تلقائيًا إلى A2UI عند الاتصال عندما يتم الإعلان عن عنوان URL لمضيف اللوحة.
- عُد إلى الهيكل الافتراضي المدمج باستخدام `canvas.navigate` و`{"url":""}`.

### قماش فاس / لقطة

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## الاستيقاظ الصوتي + وضع التحدث

- يتوفر الاستيقاظ الصوتي ووضع التحدث في الإعدادات.
- قد يعلّق iOS الصوت في الخلفية؛ تعامل مع ميزات الصوت على أنها «أفضل جهد» عندما لا يكون التطبيق نشطًا.

## أخطاء شائعة

- `NODE_BACKGROUND_UNAVAILABLE`: اجلب تطبيق iOS إلى الواجهة (تتطلب أوامر اللوحة/الكاميرا/الشاشة ذلك).
- `A2UI_HOST_NOT_CONFIGURED`: لم يعلن Gateway عن عنوان URL لمضيف اللوحة؛ تحقّق من `canvasHost` في [تهيئة Gateway](/gateway/configuration).
- لا يظهر طلب الإقران أبدًا: شغّل `openclaw nodes pending` ووافق يدويًا.
- فشل إعادة الاتصال بعد إعادة التثبيت: تم مسح رمز الإقران من Keychain؛ أعد إقران العُقدة.

## مستندات ذات صلة

- [الإقران](/gateway/pairing)
- [الاكتشاف](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
