---
summary: "WKWebView + کسٹم URL اسکیم کے ذریعے ایمبیڈ کیا گیا ایجنٹ کے زیرِ کنٹرول Canvas پینل"
read_when:
  - macOS Canvas پینل نافذ کرتے وقت
  - بصری ورک اسپیس کے لیے ایجنٹ کنٹرولز شامل کرتے وقت
  - WKWebView میں Canvas لوڈز کی ڈیبگنگ کرتے وقت
title: "Canvas"
---

# Canvas (macOS ایپ)

macOS ایپ `WKWebView` کا استعمال کرتے ہوئے ایک ایجنٹ کے زیرِ کنٹرول **Canvas panel** ایمبیڈ کرتی ہے۔ یہ
HTML/CSS/JS، A2UI، اور چھوٹے انٹرایکٹو UI سرفیسز کے لیے ایک ہلکا پھلکا بصری ورک اسپیس ہے۔

## Canvas کہاں رہتا ہے

Canvas کی حالت Application Support کے تحت محفوظ کی جاتی ہے:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas پینل ان فائلوں کو **کسٹم URL اسکیم** کے ذریعے فراہم کرتا ہے:

- `openclaw-canvas://<session>/<path>`

مثالیں:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

اگر روٹ پر کوئی `index.html` موجود نہ ہو تو ایپ ایک **بلٹ اِن اسکیفولڈ صفحہ** دکھاتی ہے۔

## پینل کا رویہ

- بارڈر کے بغیر، قابلِ سائز پینل جو مینو بار (یا ماؤس کرسر) کے قریب اینکر ہوتا ہے۔
- ہر سیشن کے لیے سائز/پوزیشن یاد رکھتا ہے۔
- مقامی canvas فائلوں میں تبدیلی پر خودکار طور پر دوبارہ لوڈ ہوتا ہے۔
- ایک وقت میں صرف ایک Canvas پینل نظر آتا ہے (ضرورت کے مطابق سیشن بدلا جاتا ہے)۔

Canvas کو Settings → **Allow Canvas** سے غیر فعال کیا جا سکتا ہے۔ غیر فعال ہونے پر، canvas
نوڈ کمانڈز `CANVAS_DISABLED` واپس کرتی ہیں۔

## ایجنٹ API سطح

Canvas کو **Gateway WebSocket** کے ذریعے ایکسپوز کیا گیا ہے، تاکہ ایجنٹ یہ کر سکے:

- پینل دکھانا/چھپانا
- کسی پاتھ یا URL پر نیویگیٹ کرنا
- JavaScript کو ایویلیویٹ کرنا
- اسنیپ شاٹ تصویر کیپچر کرنا

CLI مثالیں:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

نوٹس:

- `canvas.navigate` **مقامی canvas پاتھس**، `http(s)` URLs، اور `file://` URLs قبول کرتا ہے۔
- اگر آپ `"/"` پاس کریں تو Canvas مقامی اسکیفولڈ یا `index.html` دکھاتا ہے۔

## Canvas میں A2UI

A2UI کو Gateway canvas host کے ذریعے ہوسٹ کیا جاتا ہے اور Canvas panel کے اندر رینڈر کیا جاتا ہے۔
جب Gateway ایک Canvas host کا اعلان کرتا ہے تو macOS ایپ
پہلی بار کھلنے پر خود بخود A2UI host صفحے پر نیویگیٹ کرتی ہے۔

ڈیفالٹ A2UI ہوسٹ URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI کمانڈز (v0.8)

Canvas اس وقت **A2UI v0.8** سرور→کلائنٹ پیغامات قبول کرتا ہے:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) سپورٹڈ نہیں ہے۔

CLI مثال:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

فوری اسموک:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas سے ایجنٹ رنز کو ٹرگر کرنا

Canvas ڈیپ لنکس کے ذریعے نئے ایجنٹ رنز کو ٹرگر کر سکتا ہے:

- `openclaw://agent?...`

مثال (JS میں):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

جب تک کوئی معتبر کلید فراہم نہ کی جائے، ایپ تصدیق کے لیے پرامپٹ کرتی ہے۔

## سکیورٹی نوٹس

- Canvas اسکیم ڈائریکٹری ٹریورسل کو بلاک کرتی ہے؛ فائلیں لازماً سیشن روٹ کے تحت ہونی چاہئیں۔
- مقامی Canvas مواد ایک کسٹم اسکیم استعمال کرتا ہے (کسی local loopback سرور کی ضرورت نہیں)۔
- بیرونی `http(s)` URLs صرف اسی وقت اجازت یافتہ ہیں جب واضح طور پر نیویگیٹ کیا جائے۔
