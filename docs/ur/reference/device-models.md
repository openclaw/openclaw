---
summary: "macOS ایپ میں دوستانہ ناموں کے لیے OpenClaw کس طرح Apple ڈیوائس ماڈل شناخت کاروں کو فراہم کرتا ہے۔"
read_when:
  - ڈیوائس ماڈل شناخت کار میپنگز یا NOTICE/لائسنس فائلوں کو اپڈیٹ کرتے وقت
  - Instances UI میں ڈیوائس ناموں کی نمائش کے طریقے میں تبدیلی کرتے وقت
title: "ڈیوائس ماڈل ڈیٹابیس"
---

# ڈیوائس ماڈل ڈیٹابیس (دوستانہ نام)

macOS کمپینین ایپ **Instances** UI میں دوستانہ Apple ڈیوائس ماڈل نام دکھاتی ہے، جو Apple ماڈل شناخت کاروں (مثلاً `iPad16,6`، `Mac16,6`) کو انسانی طور پر قابلِ فہم ناموں سے میپ کرتی ہے۔

یہ میپنگ JSON کی صورت میں یہاں وینڈر کی جاتی ہے:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## ڈیٹا کا ماخذ

ہم فی الحال یہ میپنگ MIT-لائسنس یافتہ ریپوزٹری سے وینڈر کرتے ہیں:

- `kyle-seongwoo-jun/apple-device-identifiers`

بلڈز کو قابلِ تکرار رکھنے کے لیے، JSON فائلیں مخصوص اپ اسٹریم کمٹس پر پن کی جاتی ہیں (جو `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` میں ریکارڈ ہوتی ہیں)۔

## ڈیٹابیس کو اپڈیٹ کرنا

1. وہ اپ اسٹریم کمٹس منتخب کریں جن پر آپ پن کرنا چاہتے ہیں (ایک iOS کے لیے، ایک macOS کے لیے)۔
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` میں کمٹ ہیشز اپڈیٹ کریں۔
3. انہی کمٹس پر پن کی گئی JSON فائلیں دوبارہ ڈاؤن لوڈ کریں:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. یقینی بنائیں کہ `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` اب بھی اپ اسٹریم سے مطابقت رکھتی ہے (اگر اپ اسٹریم لائسنس تبدیل ہو تو اسے بدل دیں)۔
5. تصدیق کریں کہ macOS ایپ صاف طور پر بلڈ ہو جاتی ہے (کوئی وارننگ نہیں):

```bash
swift build --package-path apps/macos
```
