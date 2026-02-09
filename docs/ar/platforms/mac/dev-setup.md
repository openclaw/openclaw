---
summary: "دليل إعداد للمطورين العاملين على تطبيق OpenClaw لنظام macOS"
read_when:
  - إعداد بيئة تطوير macOS
title: "إعداد تطوير macOS"
---

# إعداد مطوري macOS

يغطي هذا الدليل الخطوات اللازمة لبناء وتشغيل تطبيق OpenClaw لنظام macOS من الشيفرة المصدرية.

## المتطلبات المسبقة

قبل بناء التطبيق، تأكد من تثبيت ما يلي:

1. **Xcode 26.2+**: مطلوب لتطوير Swift.
2. **Node.js 22+ و pnpm**: مطلوبان للـ Gateway وواجهة CLI ونصوص التغليف.

## 1) تثبيت التبعيات

قم بتثبيت تبعيات المشروع على مستوى المستودع:

```bash
pnpm install
```

## 2. بناء وتغليف التطبيق

لبناء تطبيق macOS وتغليفه ضمن `dist/OpenClaw.app`، شغّل:

```bash
./scripts/package-mac-app.sh
```

إذا لم يكن لديك شهادة Apple Developer ID، فسيستخدم النص البرمجي تلقائيًا **التوقيع المؤقت (ad-hoc signing)** (`-`).

لأوضاع التشغيل التطويرية، وأعلام التوقيع، واستكشاف أخطاء Team ID وإصلاحها، راجع ملف README الخاص بتطبيق macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **ملاحظة**: قد تؤدي التطبيقات الموقعة بتوقيع مؤقت إلى ظهور مطالبات أمان. إذا تعطل التطبيق فورًا مع رسالة «Abort trap 6»، فراجع قسم [استكشاف الأخطاء وإصلاحها](#troubleshooting).

## 3. تثبيت واجهة CLI

يتوقع تطبيق macOS وجود تثبيت عام لواجهة `openclaw` CLI لإدارة المهام في الخلفية.

**لتثبيتها (موصى به):**

1. افتح تطبيق OpenClaw.
2. انتقل إلى تبويب الإعدادات **General**.
3. انقر **"Install CLI"**.

بدلًا من ذلك، يمكنك تثبيتها يدويًا:

```bash
npm install -g openclaw@<version>
```

## استكشاف الأخطاء وإصلاحها

### فشل البناء: عدم توافق سلسلة الأدوات أو SDK

يتوقع بناء تطبيق macOS أحدث macOS SDK وسلسلة أدوات Swift 6.2.

**تبعيات النظام (مطلوبة):**

- **أحدث إصدار من macOS متاح عبر Software Update** (مطلوب من قِبل SDKs الخاصة بـ Xcode 26.2)
- **Xcode 26.2** (سلسلة أدوات Swift 6.2)

**التحقق:**

```bash
xcodebuild -version
xcrun swift --version
```

إذا لم تتطابق الإصدارات، حدّث macOS و/أو Xcode ثم أعد تشغيل عملية البناء.

### تعطل التطبيق عند منح الأذونات

إذا تعطل التطبيق عند محاولة السماح بالوصول إلى **التعرّف على الكلام** أو **الميكروفون**، فقد يكون ذلك بسبب تلف ذاكرة التخزين المؤقت لـ TCC أو عدم تطابق التوقيع.

**الإصلاح:**

1. إعادة تعيين أذونات TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. إذا لم ينجح ذلك، غيّر `BUNDLE_ID` مؤقتًا في [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) لفرض «بداية نظيفة» من macOS.

### بقاء حالة Gateway على "Starting..."

إذا ظلت حالة الـ Gateway على "Starting..."، فتحقق مما إذا كانت عملية «زومبي» تحتجز المنفذ:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

إذا كان تشغيل يدوي يحتجز المنفذ، أوقف تلك العملية (Ctrl+C). وكحل أخير، قم بإنهاء PID الذي عثرت عليه أعلاه.
