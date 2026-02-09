---
summary: "نوڈ پیئرنگ، foreground تقاضوں، اجازتوں، اور ٹول کی ناکامیوں کا ازالہ کریں"
read_when:
  - نوڈ منسلک ہے لیکن camera/canvas/screen/exec ٹولز ناکام ہو رہے ہیں
  - آپ کو نوڈ پیئرنگ بمقابلہ منظوریوں کے ذہنی ماڈل کی ضرورت ہے
title: "نوڈ خرابیوں کا ازالہ"
---

# نوڈ خرابیوں کا ازالہ

اس صفحے کو اس وقت استعمال کریں جب اسٹیٹس میں نوڈ نظر آ رہا ہو لیکن نوڈ ٹولز ناکام ہوں۔

## کمانڈ سیڑھی

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

پھر نوڈ سے متعلق مخصوص جانچ چلائیں:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

صحت مند اشارے:

- نوڈ منسلک ہے اور کردار `node` کے لیے پیئرڈ ہے۔
- `nodes describe` میں وہ صلاحیت شامل ہے جسے آپ کال کر رہے ہیں۔
- Exec منظوریات متوقع موڈ/اجازت فہرست دکھاتی ہیں۔

## Foreground تقاضے

`canvas.*`، `camera.*`، اور `screen.*` iOS/Android نوڈز پر صرف foreground میں دستیاب ہیں۔

فوری جانچ اور درستگی:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

اگر آپ `NODE_BACKGROUND_UNAVAILABLE` دیکھیں، تو نوڈ ایپ کو foreground میں لائیں اور دوبارہ کوشش کریں۔

## اجازتوں کی میٹرکس

| صلاحیت                       | iOS                                                     | Android                                                  | macOS نوڈ ایپ                                      | عام ناکامی کوڈ                 |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| `camera.snap`، `camera.clip` | کیمرا (+ کلپ آڈیو کے لیے مائیک)      | کیمرا (+ کلپ آڈیو کے لیے مائیک)       | کیمرا (+ کلپ آڈیو کے لیے مائیک) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | اسکرین ریکارڈنگ (+ مائیک اختیاری)    | اسکرین کیپچر پرامپٹ (+ مائیک اختیاری) | اسکرین ریکارڈنگ                                    | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using یا Always (موڈ پر منحصر) | موڈ کے مطابق Foreground/Background لوکیشن                | لوکیشن اجازت                                       | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (نوڈ ہوسٹ پاتھ)                  | n/a (نوڈ ہوسٹ پاتھ)                   | Exec منظوریات درکار                                | `SYSTEM_RUN_DENIED`            |

## پیئرنگ بمقابلہ منظوریات

یہ مختلف دروازے ہیں:

1. **ڈیوائس پیئرنگ**: کیا یہ نوڈ گیٹ وے سے کنیکٹ ہو سکتا ہے؟
2. **Exec منظوریات**: کیا یہ نوڈ مخصوص شیل کمانڈ چلا سکتا ہے؟

فوری جانچ:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

If pairing is missing, approve the node device first.
If pairing is fine but `system.run` fails, fix exec approvals/allowlist.

## عام نوڈ ایرر کوڈز

- `NODE_BACKGROUND_UNAVAILABLE` → ایپ بیک گراؤنڈ میں ہے؛ اسے foreground میں لائیں۔
- `CAMERA_DISABLED` → نوڈ سیٹنگز میں کیمرا ٹوگل غیر فعال ہے۔
- `*_PERMISSION_REQUIRED` → OS اجازت موجود نہیں/مسترد۔
- `LOCATION_DISABLED` → لوکیشن موڈ بند ہے۔
- `LOCATION_PERMISSION_REQUIRED` → مطلوبہ لوکیشن موڈ کی اجازت نہیں دی گئی۔
- `LOCATION_BACKGROUND_UNAVAILABLE` → ایپ بیک گراؤنڈ میں ہے لیکن صرف While Using اجازت موجود ہے۔
- `SYSTEM_RUN_DENIED: approval required` → exec درخواست کو واضح منظوری درکار ہے۔
- `SYSTEM_RUN_DENIED: allowlist miss` → کمانڈ اجازت فہرست موڈ کے باعث بلاک ہے۔

## فوری بحالی لوپ

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

اگر پھر بھی مسئلہ برقرار رہے:

- ڈیوائس پیئرنگ دوبارہ منظور کریں۔
- نوڈ ایپ دوبارہ کھولیں (foreground)۔
- OS اجازتیں دوبارہ دیں۔
- exec منظوری پالیسی دوبارہ بنائیں/ایڈجسٹ کریں۔

متعلقہ:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
