---
summary: "اینڈرائیڈ ایپ (نوڈ): کنکشن رن بُک + کینوس/چیٹ/کیمرہ"
read_when:
  - اینڈرائیڈ نوڈ کو جوڑتے یا دوبارہ کنیکٹ کرتے وقت
  - اینڈرائیڈ gateway کی دریافت یا تصدیق کی ڈیبگنگ
  - کلائنٹس کے درمیان چیٹ ہسٹری کی برابری کی توثیق
title: "اینڈرائیڈ ایپ"
---

# اینڈرائیڈ ایپ (نوڈ)

## سپورٹ اسنیپ شاٹ

- کردار: معاون نوڈ ایپ (اینڈرائیڈ Gateway ہوسٹ نہیں کرتا)۔
- Gateway درکار: ہاں (macOS، Linux، یا Windows پر WSL2 کے ذریعے چلائیں)۔
- انسٹال: [Getting Started](/start/getting-started) + [Pairing](/gateway/pairing)۔
- Gateway: [Runbook](/gateway) + [Configuration](/gateway/configuration)۔
  - پروٹوکولز: [Gateway protocol](/gateway/protocol) (نوڈز + کنٹرول پلین)۔

## سسٹم کنٹرول

12. سسٹم کنٹرول (launchd/systemd) گیٹ وے ہوسٹ پر موجود ہوتا ہے۔ See [Gateway](/gateway).

## کنکشن رن بُک

اینڈرائیڈ نوڈ ایپ ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

اینڈرائیڈ براہِ راست Gateway WebSocket (ڈیفالٹ `ws://<host>:18789`) سے کنیکٹ ہوتا ہے اور Gateway کی ملکیت والے pairing کو استعمال کرتا ہے۔

### پیشگی تقاضے

- آپ “ماسٹر” مشین پر Gateway چلا سکتے ہوں۔
- اینڈرائیڈ ڈیوائس/ایمولیٹر gateway WebSocket تک رسائی رکھتا ہو:
  - ایک ہی LAN پر mDNS/NSD کے ساتھ، **یا**
  - ایک ہی Tailscale tailnet پر Wide-Area Bonjour / unicast DNS-SD کے ذریعے (نیچے دیکھیں)، **یا**
  - دستی gateway ہوسٹ/پورٹ (فال بیک)
- آپ gateway مشین پر CLI (`openclaw`) چلا سکتے ہوں (یا SSH کے ذریعے)۔

### 1. Gateway شروع کریں

```bash
openclaw gateway --port 18789 --verbose
```

لاگز میں تصدیق کریں کہ آپ کو کچھ اس طرح نظر آئے:

- `listening on ws://0.0.0.0:18789`

صرف tailnet سیٹ اپس کے لیے (Vienna ⇄ London کے لیے سفارش کردہ)، gateway کو tailnet IP پر بائنڈ کریں:

- گیٹ وے ہوسٹ پر `~/.openclaw/openclaw.json` میں `gateway.bind: "tailnet"` سیٹ کریں۔
- Gateway / macOS مینو بار ایپ دوبارہ شروع کریں۔

### 2. دریافت کی توثیق (اختیاری)

گیٹ وے مشین سے:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

مزید ڈیبگنگ نوٹس: [Bonjour](/gateway/bonjour)۔

#### unicast DNS-SD کے ذریعے Tailnet (Vienna ⇄ London) دریافت

Android NSD/mDNS discovery won’t cross networks. 15. اگر آپ کا Android نوڈ اور گیٹ وے مختلف نیٹ ورکس پر ہیں لیکن Tailscale کے ذریعے جڑے ہوئے ہیں، تو Wide-Area Bonjour / unicast DNS-SD استعمال کریں:

1. گیٹ وے ہوسٹ پر DNS-SD زون (مثال `openclaw.internal.`) سیٹ اپ کریں اور `_openclaw-gw._tcp` ریکارڈز شائع کریں۔
2. منتخب ڈومین کے لیے Tailscale split DNS کنفیگر کریں جو اس DNS سرور کی طرف اشارہ کرے۔

تفصیلات اور مثال CoreDNS کنفیگ: [Bonjour](/gateway/bonjour)۔

### 3. اینڈرائیڈ سے کنیکٹ کریں

اینڈرائیڈ ایپ میں:

- ایپ **foreground service** (مسلسل نوٹیفکیشن) کے ذریعے gateway کنکشن کو برقرار رکھتی ہے۔
- **Settings** کھولیں۔
- **Discovered Gateways** کے تحت اپنے gateway کو منتخب کریں اور **Connect** دبائیں۔
- اگر mDNS بلاک ہو، تو **Advanced → Manual Gateway** (ہوسٹ + پورٹ) استعمال کریں اور **Connect (Manual)** دبائیں۔

پہلی کامیاب pairing کے بعد، اینڈرائیڈ لانچ پر خودکار طور پر دوبارہ کنیکٹ ہو جاتا ہے:

- دستی اینڈ پوائنٹ (اگر فعال ہو)، بصورتِ دیگر
- آخری دریافت شدہ gateway (بہترین کوشش)۔

### 4. pairing کی منظوری دیں (CLI)

گیٹ وے مشین پر:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

pairing کی تفصیلات: [Gateway pairing](/gateway/pairing)۔

### 5. نوڈ کے کنیکٹ ہونے کی توثیق کریں

- نوڈز اسٹیٹس کے ذریعے:

  ```bash
  openclaw nodes status
  ```

- Gateway کے ذریعے:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. چیٹ + ہسٹری

اینڈرائیڈ نوڈ کی چیٹ شیٹ gateway کی **primary session key** (`main`) استعمال کرتی ہے، اس لیے ہسٹری اور جوابات WebChat اور دیگر کلائنٹس کے ساتھ مشترک ہوتے ہیں:

- ہسٹری: `chat.history`
- ارسال: `chat.send`
- پُش اپ ڈیٹس (بہترین کوشش): `chat.subscribe` → `event:"chat"`

### 7. کینوس + کیمرہ

#### Gateway Canvas Host (ویب مواد کے لیے سفارش کردہ)

اگر آپ چاہتے ہیں کہ نوڈ حقیقی HTML/CSS/JS دکھائے جسے ایجنٹ ڈسک پر ایڈٹ کر سکے، تو نوڈ کو Gateway canvas host کی طرف پوائنٹ کریں۔

نوٹ: نوڈز اسٹینڈ الون کینوس ہوسٹ `canvasHost.port` پر استعمال کرتے ہیں (ڈیفالٹ `18793`)۔

1. گیٹ وے ہوسٹ پر `~/.openclaw/workspace/canvas/index.html` بنائیں۔

2. نوڈ کو اس کی طرف نیویگیٹ کریں (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (اختیاری): اگر دونوں ڈیوائسز Tailscale پر ہیں، تو `.local` کے بجائے MagicDNS نام یا tailnet IP استعمال کریں، مثلاً `http://<gateway-magicdns>:18793/__openclaw__/canvas/`۔

16. یہ سرور HTML میں ایک live-reload کلائنٹ شامل کرتا ہے اور فائلوں میں تبدیلی پر دوبارہ لوڈ کرتا ہے۔
17. A2UI ہوسٹ یہاں موجود ہے: `http://<gateway-host>:18793/__openclaw__/a2ui/`.

کینوس کمانڈز (صرف foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). `canvas.snapshot` returns `{ format, base64 }` (default `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` لیگیسی عرف)

کیمرہ کمانڈز (صرف foreground؛ اجازت پر مبنی):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

پیرامیٹرز اور CLI ہیلپرز کے لیے [Camera node](/nodes/camera) دیکھیں۔
