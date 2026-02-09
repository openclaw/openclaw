---
summary: "OpenClaw macOS ایپ پر کام کرنے والے ڈویلپرز کے لیے سیٹ اپ گائیڈ"
read_when:
  - macOS ڈویلپمنٹ ماحول سیٹ اپ کرنا
title: "macOS ڈیو سیٹ اپ"
---

# macOS ڈویلپر سیٹ اپ

یہ گائیڈ سورس سے OpenClaw macOS ایپلیکیشن کو بنانے اور چلانے کے لیے درکار ضروری مراحل کا احاطہ کرتی ہے۔

## پیشگی تقاضے

ایپ بنانے سے پہلے، یقینی بنائیں کہ درج ذیل انسٹال ہوں:

1. **Xcode 26.2+**: Swift ڈویلپمنٹ کے لیے درکار۔
2. **Node.js 22+ اور pnpm**: gateway، CLI، اور پیکیجنگ اسکرپٹس کے لیے درکار۔

## 1) Dependencies انسٹال کریں

پراجیکٹ سطح کے انحصارات انسٹال کریں:

```bash
pnpm install
```

## 2. ایپ کو بلڈ اور پیکیج کریں

macOS ایپ بنانے اور اسے `dist/OpenClaw.app` میں پیکیج کرنے کے لیے، یہ چلائیں:

```bash
./scripts/package-mac-app.sh
```

اگر آپ کے پاس Apple Developer ID سرٹیفکیٹ نہیں ہے، تو اسکرپٹ خودکار طور پر **ad-hoc signing** (`-`) استعمال کرے گا۔

ڈیولپمنٹ رن موڈز، سائننگ فلیگز، اور Team ID سے متعلق خرابیوں کے ازالے کے لیے macOS ایپ README دیکھیں:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **نوٹ**: Ad-hoc سائن کی گئی ایپس سیکیورٹی پرامپٹس دکھا سکتی ہیں۔ اگر ایپ فوراً "Abort trap 6" کے ساتھ کریش ہو جائے تو [Troubleshooting](#troubleshooting) سیکشن دیکھیں۔

## 3. CLI انسٹال کریں

macOS ایپ بیک گراؤنڈ ٹاسکس کے انتظام کے لیے عالمی `openclaw` CLI انسٹال کی توقع رکھتی ہے۔

**انسٹال کرنے کے لیے (سفارش کردہ):**

1. OpenClaw ایپ کھولیں۔
2. **General** سیٹنگز ٹیب پر جائیں۔
3. **"Install CLI"** پر کلک کریں۔

متبادل کے طور پر، اسے دستی طور پر انسٹال کریں:

```bash
npm install -g openclaw@<version>
```

## خرابیوں کا ازالہ

### بلڈ ناکام: ٹول چین یا SDK عدم مطابقت

macOS ایپ بلڈ کے لیے تازہ ترین macOS SDK اور Swift 6.2 ٹول چین درکار ہے۔

**سسٹم انحصارات (لازم):**

- **Software Update میں دستیاب تازہ ترین macOS ورژن** (Xcode 26.2 SDKs کے لیے درکار)
- **Xcode 26.2** (Swift 6.2 ٹول چین)

**چیکس:**

```bash
xcodebuild -version
xcrun swift --version
```

اگر ورژنز مطابقت نہیں رکھتے، تو macOS/Xcode اپ ڈیٹ کریں اور بلڈ دوبارہ چلائیں۔

### اجازت دینے پر ایپ کریش ہو جاتی ہے

اگر **Speech Recognition** یا **Microphone** تک رسائی کی اجازت دیتے وقت ایپ کریش ہو جائے، تو یہ خراب TCC کیش یا دستخطی عدم مطابقت کی وجہ سے ہو سکتا ہے۔

**حل:**

1. TCC اجازتیں ری سیٹ کریں:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. اگر یہ ناکام ہو جائے، تو macOS سے "clean slate" نافذ کرنے کے لیے [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) میں `BUNDLE_ID` کو عارضی طور پر تبدیل کریں۔

### Gateway "Starting..." پر لامتناہی طور پر رکا ہوا

اگر gateway کی اسٹیٹس "Starting..." پر ہی رہے تو چیک کریں کہ کہیں کوئی zombie پروسیس پورٹ کو تھامے ہوئے تو نہیں:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

اگر کوئی دستی رن پورٹ کو تھامے ہوئے ہے تو اس پروسیس کو روک دیں (Ctrl+C)۔ آخری حل کے طور پر، اوپر ملنے والا PID ختم کر دیں۔
