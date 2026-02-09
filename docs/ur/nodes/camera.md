---
summary: "ایجنٹ کے استعمال کے لیے کیمرہ کیپچر (iOS نوڈ + macOS ایپ): تصاویر (jpg) اور مختصر ویڈیو کلپس (mp4)"
read_when:
  - iOS نوڈز یا macOS پر کیمرہ کیپچر شامل یا تبدیل کرتے وقت
  - ایجنٹ کی رسائی والے MEDIA عارضی فائل ورک فلو کو توسیع دیتے وقت
title: "Camera Capture"
---

# کیمرہ کیپچر (ایجنٹ)

OpenClaw ایجنٹ ورک فلو کے لیے **کیمرہ کیپچر** کی سہولت فراہم کرتا ہے:

- **iOS نوڈ** (Gateway کے ذریعے جوڑا گیا): `node.invoke` کے ذریعے **تصویر** (`jpg`) یا **مختصر ویڈیو کلپ** (`mp4`، اختیاری آڈیو کے ساتھ) کیپچر کریں۔
- **Android نوڈ** (Gateway کے ذریعے جوڑا گیا): `node.invoke` کے ذریعے **تصویر** (`jpg`) یا **مختصر ویڈیو کلپ** (`mp4`، اختیاری آڈیو کے ساتھ) کیپچر کریں۔
- **macOS ایپ** (Gateway کے ذریعے نوڈ): `node.invoke` کے ذریعے **تصویر** (`jpg`) یا **مختصر ویڈیو کلپ** (`mp4`، اختیاری آڈیو کے ساتھ) کیپچر کریں۔

تمام کیمرہ رسائی **صارف کے زیرِ کنٹرول سیٹنگز** کے تحت محدود ہے۔

## iOS نوڈ

### صارف کی سیٹنگ (بطورِ طے شدہ آن)

- iOS Settings ٹیب → **Camera** → **Allow Camera** (`camera.enabled`)
  - بطورِ طے شدہ: **آن** (غائب کلید کو فعال سمجھا جاتا ہے)۔
  - بند ہونے پر: `camera.*` کمانڈز `CAMERA_DISABLED` واپس کرتی ہیں۔

### کمانڈز (Gateway `node.invoke` کے ذریعے)

- `camera.list`
  - Response payload:
    - `devices`: `{ id, name, position, deviceType }` کی array

- `camera.snap`
  - Params:
    - `facing`: `front|back` (بطورِ طے شدہ: `front`)
    - `maxWidth`: number (اختیاری؛ iOS نوڈ پر بطورِ طے شدہ `1600`)
    - `quality`: `0..1` (اختیاری؛ بطورِ طے شدہ `0.9`)
    - `format`: فی الحال `jpg`
    - `delayMs`: number (اختیاری؛ بطورِ طے شدہ `0`)
    - `deviceId`: string (اختیاری؛ `camera.list` سے)
  - Response payload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Payload guard: تصاویر کو دوبارہ کمپریس کیا جاتا ہے تاکہ base64 payload 5 MB سے کم رہے۔

- `camera.clip`
  - Params:
    - `facing`: `front|back` (بطورِ طے شدہ: `front`)
    - `durationMs`: number (بطورِ طے شدہ `3000`، زیادہ سے زیادہ `60000` تک محدود)
    - `includeAudio`: boolean (بطورِ طے شدہ `true`)
    - `format`: فی الحال `mp4`
    - `deviceId`: string (اختیاری؛ `camera.list` سے)
  - Response payload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### فارگراؤنڈ کی شرط

Like `canvas.*`, the iOS node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### CLI معاون (عارضی فائلیں + MEDIA)

اٹیچمنٹس حاصل کرنے کا سب سے آسان طریقہ CLI معاون ہے، جو ڈی کوڈ شدہ میڈیا کو ایک عارضی فائل میں لکھتا ہے اور `MEDIA:<path>` پرنٹ کرتا ہے۔

مثالیں:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

نوٹس:

- `nodes camera snap` بطورِ طے شدہ **دونوں** رخ استعمال کرتا ہے تاکہ ایجنٹ کو دونوں مناظر مل سکیں۔
- آؤٹ پٹ فائلیں عارضی ہوتی ہیں (OS کی temp ڈائریکٹری میں) جب تک کہ آپ اپنی رَیپر نہ بنائیں۔

## Android نوڈ

### Android صارف کی سیٹنگ (بطورِ طے شدہ آن)

- Android Settings شیٹ → **Camera** → **Allow Camera** (`camera.enabled`)
  - بطورِ طے شدہ: **آن** (غائب کلید کو فعال سمجھا جاتا ہے)۔
  - بند ہونے پر: `camera.*` کمانڈز `CAMERA_DISABLED` واپس کرتی ہیں۔

### اجازتیں

- Android کو رن ٹائم اجازتیں درکار ہوتی ہیں:
  - `CAMERA` دونوں `camera.snap` اور `camera.clip` کے لیے۔
  - `RECORD_AUDIO` `camera.clip` کے لیے جب `includeAudio=true`۔

اگر اجازتیں موجود نہ ہوں تو ایپ ممکن ہونے پر پرامپٹ دکھائے گی؛ اگر انکار ہو جائے تو `camera.*` کی درخواستیں
`*_PERMISSION_REQUIRED` کی خرابی کے ساتھ ناکام ہو جاتی ہیں۔

### Android فارگراؤنڈ کی شرط

Like `canvas.*`, the Android node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### Payload guard

تصاویر کو دوبارہ کمپریس کیا جاتا ہے تاکہ base64 payload 5 MB سے کم رہے۔

## macOS ایپ

### صارف کی سیٹنگ (بطورِ طے شدہ بند)

macOS معاون ایپ ایک چیک باکس فراہم کرتی ہے:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - بطورِ طے شدہ: **بند**
  - بند ہونے پر: کیمرہ کی درخواستیں “Camera disabled by user” واپس کرتی ہیں۔

### CLI معاون (نوڈ invoke)

macOS نوڈ پر کیمرہ کمانڈز چلانے کے لیے مرکزی `openclaw` CLI استعمال کریں۔

مثالیں:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

نوٹس:

- `openclaw nodes camera snap` بطورِ طے شدہ `maxWidth=1600` ہوتا ہے جب تک اووررائیڈ نہ کیا جائے۔
- macOS پر، `camera.snap` وارم اپ/ایکسپوژر کے استحکام کے بعد `delayMs` (بطورِ طے شدہ 2000ms) انتظار کرتا ہے، پھر کیپچر کرتا ہے۔
- تصویر کے payloads کو دوبارہ کمپریس کیا جاتا ہے تاکہ base64 5 MB سے کم رہے۔

## حفاظت + عملی حدود

- کیمرہ اور مائیکروفون کی رسائی عام OS اجازتوں کے پرامپٹس کو متحرک کرتی ہے (اور Info.plist میں usage strings درکار ہوتی ہیں)۔
- ویڈیو کلپس کی حد مقرر ہے (فی الحال `<= 60s`) تاکہ نوڈ payloads بہت بڑے نہ ہوں (base64 اوورہیڈ + پیغام کی حدود)۔

## macOS اسکرین ویڈیو (OS سطح)

_اسکرین_ ویڈیو کے لیے (کیمرہ نہیں)، macOS معاون استعمال کریں:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

نوٹس:

- macOS **Screen Recording** اجازت (TCC) درکار ہوتی ہے۔
