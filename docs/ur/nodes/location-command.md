---
summary: "نوڈز کے لیے لوکیشن کمانڈ (location.get)، اجازت کے موڈز، اور بیک گراؤنڈ رویّہ"
read_when:
  - لوکیشن نوڈ سپورٹ یا اجازتوں کی UI شامل کرتے وقت
  - بیک گراؤنڈ لوکیشن + پُش فلو ڈیزائن کرتے وقت
title: "لوکیشن کمانڈ"
---

# لوکیشن کمانڈ (نوڈز)

## TL;DR

- `location.get` ایک نوڈ کمانڈ ہے (بذریعہ `node.invoke`)۔
- بطورِ طے شدہ بند۔
- سیٹنگز میں سلیکٹر استعمال ہوتا ہے: بند / استعمال کے دوران / ہمیشہ۔
- علیحدہ ٹوگل: Precise Location۔

## سلیکٹر کیوں (صرف سوئچ کیوں نہیں)

OS permissions are multi-level. We can expose a selector in-app, but the OS still decides the actual grant.

- iOS/macOS: user can choose **While Using** or **Always** in system prompts/Settings. App can request upgrade, but OS may require Settings.
- Android: بیک گراؤنڈ لوکیشن ایک الگ اجازت ہے؛ Android 10+ پر عموماً سیٹنگز فلو درکار ہوتا ہے۔
- Precise location ایک علیحدہ منظوری ہے (iOS 14+ “Precise”، Android میں “fine” بمقابلہ “coarse”)۔

UI میں سلیکٹر ہماری درخواست کردہ موڈ کی رہنمائی کرتا ہے؛ اصل منظوری OS سیٹنگز میں ہوتی ہے۔

## سیٹنگز ماڈل

ہر نوڈ ڈیوائس کے لیے:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI رویّہ:

- `whileUsing` منتخب کرنے سے فورگراؤنڈ اجازت کی درخواست کی جاتی ہے۔
- `always` منتخب کرنے پر پہلے `whileUsing` کو یقینی بنایا جاتا ہے، پھر بیک گراؤنڈ کی درخواست کی جاتی ہے (یا ضرورت ہو تو صارف کو سیٹنگز پر بھیجا جاتا ہے)۔
- اگر OS مطلوبہ سطح مسترد کر دے، تو سب سے بلند منظور شدہ سطح پر واپس آ جائیں اور اسٹیٹس دکھائیں۔

## اجازتوں کی میپنگ (node.permissions)

Optional. macOS node reports `location` via the permissions map; iOS/Android may omit it.

## کمانڈ: `location.get`

`node.invoke` کے ذریعے کال کی جاتی ہے۔

Params (تجویز کردہ):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Response payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Errors (مستحکم کوڈز):

- `LOCATION_DISABLED`: سلیکٹر بند ہے۔
- `LOCATION_PERMISSION_REQUIRED`: مطلوبہ موڈ کے لیے اجازت موجود نہیں۔
- `LOCATION_BACKGROUND_UNAVAILABLE`: ایپ بیک گراؤنڈ میں ہے مگر صرف While Using کی اجازت ہے۔
- `LOCATION_TIMEOUT`: مقررہ وقت میں فکس نہیں ملا۔
- `LOCATION_UNAVAILABLE`: سسٹم ناکامی / فراہم کنندگان دستیاب نہیں۔

## بیک گراؤنڈ رویّہ (مستقبل)

ہدف: ماڈل نوڈ کے بیک گراؤنڈ ہونے پر بھی لوکیشن کی درخواست کر سکے، مگر صرف اس صورت میں جب:

- صارف نے **Always** منتخب کیا ہو۔
- OS بیک گراؤنڈ لوکیشن کی اجازت دے۔
- ایپ کو لوکیشن کے لیے بیک گراؤنڈ میں چلنے کی اجازت ہو (iOS بیک گراؤنڈ موڈ / Android فورگراؤنڈ سروس یا خصوصی اجازت)۔

پُش سے متحرک فلو (مستقبل):

1. Gateway نوڈ کو پُش بھیجتا ہے (سائلنٹ پُش یا FCM ڈیٹا)۔
2. نوڈ مختصر طور پر جاگتا ہے اور ڈیوائس سے لوکیشن کی درخواست کرتا ہے۔
3. نوڈ پےلوڈ Gateway کو آگے بھیجتا ہے۔

نوٹس:

- iOS: Always permission + background location mode required. Silent push may be throttled; expect intermittent failures.
- Android: بیک گراؤنڈ لوکیشن کے لیے فورگراؤنڈ سروس درکار ہو سکتی ہے؛ بصورتِ دیگر انکار متوقع ہے۔

## ماڈل/ٹولنگ انضمام

- ٹول سطح: `nodes` ٹول `location_get` ایکشن شامل کرتا ہے (نوڈ درکار)۔
- CLI: `openclaw nodes location get --node <id>`۔
- ایجنٹ رہنما اصول: صرف تب کال کریں جب صارف نے لوکیشن فعال کی ہو اور دائرۂ کار کو سمجھتا ہو۔

## UX کاپی (تجویز کردہ)

- بند: “لوکیشن شیئرنگ غیر فعال ہے۔”
- While Using: “صرف جب OpenClaw کھلا ہو۔”
- Always: “Allow background location. Requires system permission.”
- Precise: “Use precise GPS location. Toggle off to share approximate location.”
