---
summary: "بيئة تشغيل Gateway على macOS (خدمة launchd خارجية)"
read_when:
  - حزم OpenClaw.app
  - تصحيح أخطاء خدمة launchd الخاصة بـ Gateway على macOS
  - تثبيت CLI الخاص بـ Gateway لنظام macOS
title: "Gateway على macOS"
---

# Gateway على macOS (launchd خارجي)

لم يعد OpenClaw.app يضمّن Node/Bun أو بيئة تشغيل Gateway. يتوقع تطبيق macOS تثبيت CLI **خارجي** `openclaw`، ولا يشغّل Gateway كعملية فرعية، ويدير خدمة launchd لكل مستخدم للحفاظ على تشغيل Gateway (أو يرتبط بـ Gateway محلي موجود بالفعل إذا كان يعمل).

## تثبيت CLI (مطلوب للوضع المحلي)

تحتاج إلى Node 22+ على جهاز Mac، ثم ثبّت `openclaw` على مستوى النظام:

```bash
npm install -g openclaw@<version>
```

زر **Install CLI** في تطبيق macOS ينفّذ التدفق نفسه عبر npm/pnpm (لا يُنصح باستخدام bun لبيئة تشغيل Gateway).

## Launchd (Gateway كـ LaunchAgent)

التسمية:

- `bot.molt.gateway` (أو `bot.molt.<profile>`؛ قد يبقى القديم `com.openclaw.*`)

موقع ملف plist (لكل مستخدم):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (أو `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

المدير:

- يتولى تطبيق macOS تثبيت/تحديث LaunchAgent في الوضع المحلي.
- يمكن لـ CLI أيضًا تثبيته: `openclaw gateway install`.

السلوك:

- خيار «OpenClaw Active» يفعّل/يعطّل LaunchAgent.
- إغلاق التطبيق **لا** يوقف Gateway (يحافظ launchd على تشغيله).
- إذا كان Gateway يعمل بالفعل على المنفذ المُهيّأ، يرتبط التطبيق به بدل بدء واحد جديد.

التسجيل:

- stdout/err الخاص بـ launchd: `/tmp/openclaw/openclaw-gateway.log`

## توافق الإصدارات

يتحقق تطبيق macOS من إصدار Gateway مقارنةً بإصداره. إذا كانا غير متوافقين، حدّث CLI العالمي ليتطابق مع إصدار التطبيق.

## التحقق من الدخان

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

ثم:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
