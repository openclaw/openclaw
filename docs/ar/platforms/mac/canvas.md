---
summary: "لوحة Canvas خاضعة لتحكم الوكيل ومُضمَّنة عبر WKWebView مع مخطط URL مخصّص"
read_when:
  - تنفيذ لوحة Canvas على macOS
  - إضافة عناصر تحكم الوكيل لمساحة عمل مرئية
  - تصحيح أخطاء تحميل Canvas عبر WKWebView
title: "Canvas"
---

# Canvas (تطبيق macOS)

يُضمِّن تطبيق macOS **لوحة Canvas** خاضعة لتحكم الوكيل باستخدام `WKWebView`. وهي
مساحة عمل مرئية خفيفة لـ HTML/CSS/JS وA2UI، وأسـطح واجهة مستخدم تفاعلية صغيرة.

## أين يوجد Canvas

تُخزَّن حالة Canvas ضمن Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

تُقدِّم لوحة Canvas هذه الملفات عبر **مخطط URL مخصّص**:

- `openclaw-canvas://<session>/<path>`

أمثلة:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

إذا لم يوجد `index.html` في الجذر، يعرض التطبيق **صفحة هيكلية مدمجة**.

## سلوك اللوحة

- لوحة بلا حدود، قابلة لتغيير الحجم، ومثبتة قرب شريط القوائم (أو مؤشر الفأرة).
- تتذكّر الحجم/الموضع لكل جلسة.
- تُعيد التحميل تلقائيًا عند تغيّر ملفات Canvas المحلية.
- تظهر لوحة Canvas واحدة فقط في أي وقت (ويُبدَّل السياق حسب الحاجة).

يمكن تعطيل Canvas من الإعدادات → **السماح بـ Canvas**. عند التعطيل، تُعيد أوامر عقدة
Canvas القيمة `CANVAS_DISABLED`.

## واجهة برمجة تطبيقات الوكيل

يُعرَض Canvas عبر **Gateway WebSocket**، بحيث يمكن للوكيل:

- إظهار/إخفاء اللوحة
- الانتقال إلى مسار أو URL
- تقييم JavaScript
- التقاط صورة لقطة

أمثلة CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

ملاحظات:

- يقبل `canvas.navigate` **مسارات Canvas المحلية**، وURLات `http(s)`، وURLات `file://`.
- إذا مرّرت `"/"`، يعرض Canvas الهيكل المحلي أو `index.html`.

## A2UI في Canvas

تُستضاف A2UI بواسطة مضيف Gateway للـ Canvas وتُعرَض داخل لوحة Canvas.
عندما يعلن Gateway عن مضيف Canvas، ينتقل تطبيق macOS تلقائيًا إلى
صفحة مضيف A2UI عند الفتح الأول.

عنوان URL الافتراضي لمضيف A2UI:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### أوامر A2UI (الإصدار 0.8)

يقبل Canvas حاليًا رسائل الخادم→العميل **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

إن `createSurface` (الإصدار 0.9) غير مدعوم.

مثال CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

دخان سريع:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## تشغيل مهام الوكيل من Canvas

يمكن لـ Canvas تشغيل مهام وكيل جديدة عبر الروابط العميقة:

- `openclaw://agent?...`

مثال (في JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

يطالب التطبيق بالتأكيد ما لم يتم توفير مفتاح صالح.

## ملاحظات أمنية

- يمنع مخطط Canvas اجتياز الدلائل؛ يجب أن تعيش الملفات ضمن جذر الجلسة.
- يستخدم محتوى Canvas المحلي مخططًا مخصّصًا (لا يتطلب خادم loopback).
- يُسمح بعناوين URL الخارجية `http(s)` فقط عند الانتقال إليها صراحةً.
