---
summary: "Chrome ایکسٹینشن: OpenClaw کو آپ کے موجودہ Chrome ٹیب کو کنٹرول کرنے دیں"
read_when:
  - آپ چاہتے ہیں کہ ایجنٹ موجودہ Chrome ٹیب کو کنٹرول کرے (ٹول بار بٹن)
  - آپ کو ریموٹ Gateway + مقامی براؤزر آٹومیشن Tailscale کے ذریعے درکار ہے
  - آپ براؤزر ٹیک اوور کے سکیورٹی مضمرات کو سمجھنا چاہتے ہیں
title: "Chrome ایکسٹینشن"
---

# Chrome ایکسٹینشن (براؤزر ریلے)

OpenClaw Chrome ایکسٹینشن ایجنٹ کو آپ کے **موجودہ Chrome ٹیبز** (آپ کی عام Chrome ونڈو) کو کنٹرول کرنے دیتی ہے، بجائے اس کے کہ ایک الگ openclaw-managed Chrome پروفائل لانچ کیا جائے۔

اٹیچ/ڈی ٹیچ **ایک ہی Chrome ٹول بار بٹن** کے ذریعے ہوتا ہے۔

## یہ کیا ہے (تصور)

اس کے تین حصے ہیں:

- **براؤزر کنٹرول سروس** (Gateway یا نوڈ): وہ API جسے ایجنٹ/ٹول کال کرتا ہے (Gateway کے ذریعے)
- **لوکل ریلے سرور** (loopback CDP): کنٹرول سرور اور ایکسٹینشن کے درمیان پل بناتا ہے (بطورِ طے شدہ `http://127.0.0.1:18792`)
- **Chrome MV3 ایکسٹینشن**: `chrome.debugger` استعمال کرتے ہوئے ایکٹو ٹیب سے اٹیچ ہوتی ہے اور CDP پیغامات کو ریلے تک پائپ کرتی ہے

اس کے بعد OpenClaw منتخب پروفائل کے ذریعے معمول کے `browser` ٹول سرفیس کے ذریعے منسلک ٹیب کو کنٹرول کرتا ہے۔

## انسٹال / لوڈ کریں (unpacked)

1. ایکسٹینشن کو ایک مستحکم لوکل پاتھ پر انسٹال کریں:

```bash
openclaw browser extension install
```

2. انسٹال شدہ ایکسٹینشن ڈائریکٹری پاتھ پرنٹ کریں:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- “Developer mode” فعال کریں
- “Load unpacked” → اوپر پرنٹ کی گئی ڈائریکٹری منتخب کریں

4. ایکسٹینشن کو پن کریں۔

## اپڈیٹس (کوئی build مرحلہ نہیں)

The extension ships inside the OpenClaw release (npm package) as static files. There is no separate “build” step.

OpenClaw اپگریڈ کرنے کے بعد:

- `openclaw browser extension install` دوبارہ چلائیں تاکہ آپ کی OpenClaw اسٹیٹ ڈائریکٹری کے تحت انسٹال شدہ فائلیں ریفریش ہوں۔
- Chrome → `chrome://extensions` → ایکسٹینشن پر “Reload” پر کلک کریں۔

## استعمال کریں (کوئی اضافی کنفیگ نہیں)

OpenClaw ایک بلٹ اِن براؤزر پروفائل کے ساتھ آتا ہے جس کا نام `chrome` ہے، جو ڈیفالٹ پورٹ پر ایکسٹینشن ریلے کو ہدف بناتا ہے۔

اسے استعمال کریں:

- CLI: `openclaw browser --browser-profile chrome tabs`
- ایجنٹ ٹول: `browser` کے ساتھ `profile="chrome"`

اگر آپ کوئی مختلف نام یا مختلف ریلے پورٹ چاہتے ہیں تو اپنا پروفائل بنائیں:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## اٹیچ / ڈی ٹیچ (ٹول بار بٹن)

- وہ ٹیب کھولیں جسے آپ OpenClaw سے کنٹرول کروانا چاہتے ہیں۔
- ایکسٹینشن آئیکن پر کلک کریں۔
  - اٹیچ ہونے پر بیج `ON` دکھاتا ہے۔
- دوبارہ کلک کریں تو ڈی ٹیچ ہو جائے گا۔

## یہ کس ٹیب کو کنٹرول کرتی ہے؟

- یہ خودکار طور پر “جس ٹیب کو آپ دیکھ رہے ہیں” اسے کنٹرول نہیں کرتی۔
- یہ **صرف انہی ٹیبز** کو کنٹرول کرتی ہے جنہیں آپ نے ٹول بار بٹن پر کلک کر کے واضح طور پر اٹیچ کیا ہو۔
- سوئچ کرنے کے لیے: دوسرا ٹیب کھولیں اور وہاں ایکسٹینشن آئیکن پر کلک کریں۔

## بیج + عام غلطیاں

- `ON`: اٹیچ ہے؛ OpenClaw اس ٹیب کو چلا سکتا ہے۔
- `…`: لوکل ریلے سے کنیکٹ ہو رہا ہے۔
- `!`: ریلے قابلِ رسائی نہیں (سب سے عام وجہ: براؤزر ریلے سرور اس مشین پر چل نہیں رہا)۔

اگر آپ `!` دیکھیں:

- یقینی بنائیں کہ Gateway لوکل طور پر چل رہا ہے (ڈیفالٹ سیٹ اپ)، یا اگر Gateway کہیں اور چل رہا ہے تو اس مشین پر نوڈ ہوسٹ چلائیں۔
- ایکسٹینشن کا Options صفحہ کھولیں؛ وہاں دکھایا جاتا ہے کہ ریلے قابلِ رسائی ہے یا نہیں۔

## ریموٹ Gateway (نوڈ ہوسٹ استعمال کریں)

### لوکل Gateway (Chrome والی ہی مشین) — عموماً **کوئی اضافی اقدامات نہیں**

If the Gateway runs on the same machine as Chrome, it starts the browser control service on loopback
and auto-starts the relay server. The extension talks to the local relay; the CLI/tool calls go to the Gateway.

### ریموٹ Gateway (Gateway کہیں اور چل رہا ہو) — **نوڈ ہوسٹ چلائیں**

If your Gateway runs on another machine, start a node host on the machine that runs Chrome.
The Gateway will proxy browser actions to that node; the extension + relay stay local to the browser machine.

اگر متعدد نوڈز کنیکٹ ہوں تو ایک کو `gateway.nodes.browser.node` کے ساتھ پن کریں یا `gateway.nodes.browser.mode` سیٹ کریں۔

## Sandboxing (ٹول کنٹینرز)

اگر آپ کا ایجنٹ سیشن sandboxed ہے (`agents.defaults.sandbox.mode != "off"`) تو `browser` ٹول محدود ہو سکتا ہے:

- بطورِ طے شدہ، sandboxed سیشنز اکثر **sandbox براؤزر** (`target="sandbox"`) کو ہدف بناتے ہیں، نہ کہ آپ کے ہوسٹ Chrome کو۔
- Chrome ایکسٹینشن ریلے ٹیک اوور کے لیے **ہوسٹ** براؤزر کنٹرول سرور کو کنٹرول کرنا ضروری ہے۔

اختیارات:

- سب سے آسان: ایکسٹینشن کو **غیر-sandboxed** سیشن/ایجنٹ سے استعمال کریں۔
- یا sandboxed سیشنز کے لیے ہوسٹ براؤزر کنٹرول کی اجازت دیں:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

پھر یقینی بنائیں کہ ٹول پالیسی کے ذریعے بلاک نہ ہو، اور (اگر ضرورت ہو) `browser` کو `target="host"` کے ساتھ کال کریں۔

ڈی بگنگ: `openclaw sandbox explain`

## ریموٹ رسائی کے مشورے

- Gateway اور نوڈ ہوسٹ کو ایک ہی tailnet پر رکھیں؛ ریلے پورٹس کو LAN یا پبلک انٹرنیٹ پر ایکسپوز کرنے سے گریز کریں۔
- نوڈز کو دانستہ طور پر جوڑا بنائیں؛ اگر آپ ریموٹ کنٹرول نہیں چاہتے تو براؤزر پراکسی روٹنگ غیر فعال کریں (`gateway.nodes.browser.mode="off"`)۔

## “extension path” کیسے کام کرتا ہے

`openclaw browser extension path` اس **انسٹال شدہ** آن-ڈسک ڈائریکٹری کو پرنٹ کرتا ہے جس میں ایکسٹینشن فائلیں موجود ہوتی ہیں۔

The CLI intentionally does **not** print a `node_modules` path. Always run `openclaw browser extension install` first to copy the extension to a stable location under your OpenClaw state directory.

اگر آپ اس انسٹال ڈائریکٹری کو منتقل یا حذف کر دیں تو Chrome ایکسٹینشن کو خراب (broken) نشان زد کر دے گا، جب تک آپ اسے کسی درست پاتھ سے دوبارہ لوڈ نہ کریں۔

## سکیورٹی مضمرات (یہ ضرور پڑھیں)

This is powerful and risky. Treat it like giving the model “hands on your browser”.

- The extension uses Chrome’s debugger API (`chrome.debugger`). When attached, the model can:
  - اس ٹیب میں کلک/ٹائپ/نیویگیٹ کرنا
  - صفحے کے مواد کو پڑھنا
  - وہ سب کچھ ایکسیس کرنا جس تک اس ٹیب کا لاگ اِن سیشن رسائی رکھتا ہے
- **یہ علیحدہ (isolated) نہیں ہے** جیسے مخصوص openclaw-managed پروفائل۔
  - اگر آپ اپنے روزمرہ استعمال کے پروفائل/ٹیب سے اٹیچ کرتے ہیں تو آپ اس اکاؤنٹ کی اسٹیٹ تک رسائی دے رہے ہوتے ہیں۔

سفارشات:

- ایکسٹینشن ریلے کے استعمال کے لیے ایک مخصوص Chrome پروفائل کو ترجیح دیں (ذاتی براؤزنگ سے الگ)۔
- Gateway اور کسی بھی نوڈ ہوسٹ کو صرف tailnet تک محدود رکھیں؛ Gateway تصدیق + نوڈ pairing پر انحصار کریں۔
- ریلے پورٹس کو LAN پر ایکسپوز کرنے سے گریز کریں (`0.0.0.0`) اور Funnel (پبلک) سے بھی پرہیز کریں۔
- ریلے غیر-ایکسٹینشن origins کو بلاک کرتا ہے اور CDP کلائنٹس کے لیے ایک اندرونی auth ٹوکن درکار ہوتا ہے۔

متعلقہ:

- براؤزر ٹول کا جائزہ: [Browser](/tools/browser)
- سکیورٹی آڈٹ: [Security](/gateway/security)
- Tailscale سیٹ اپ: [Tailscale](/gateway/tailscale)
