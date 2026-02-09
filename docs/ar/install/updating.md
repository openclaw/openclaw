---
summary: "تحديث OpenClaw بأمان (تثبيت عام أو من المصدر)، إضافة إلى استراتيجية التراجع"
read_when:
  - تحديث OpenClaw
  - حدوث عطل بعد تحديث
title: "التحديث"
---

# التحديث

يتحرك OpenClaw بسرعة (قبل الإصدار «1.0»). تعامل مع التحديثات كما لو كنت تشغّل بنية تحتية إنتاجية: تحديث → تشغيل الفحوصات → إعادة التشغيل (أو استخدام `openclaw update`، الذي يعيد التشغيل) → التحقق.

## الموصى به: إعادة تشغيل مُثبّت الموقع (ترقية في المكان)

مسار التحديث **المفضّل** هو إعادة تشغيل المُثبّت من الموقع. فهو
يكتشف عمليات التثبيت الموجودة، ويُجري الترقية في المكان، ويشغّل `openclaw doctor` عند الحاجة.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

ملاحظات:

- أضِف `--no-onboard` إذا كنت لا تريد تشغيل معالج الإعداد الأولي مرة أخرى.

- بالنسبة إلى **تثبيتات المصدر**، استخدم:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  سيقوم المُثبّت بـ `git pull --rebase` **فقط** إذا كان المستودع نظيفًا.

- بالنسبة إلى **التثبيتات العامة**، يستخدم السكربت `npm install -g openclaw@latest` داخليًا.

- ملاحظة قديمة: يظل `clawdbot` متاحًا كطبقة توافق.

## قبل التحديث

- اعرف طريقة التثبيت: **عام** (npm/pnpm) مقابل **من المصدر** (git clone).
- اعرف كيف يعمل Gateway لديك: **طرفية أمامية** مقابل **خدمة مُشرف عليها** (launchd/systemd).
- خذ لقطات من تخصيصاتك:
  - التهيئة: `~/.openclaw/openclaw.json`
  - بيانات الاعتماد: `~/.openclaw/credentials/`
  - مساحة العمل: `~/.openclaw/workspace`

## التحديث (تثبيت عام)

التثبيت العام (اختر واحدًا):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

نحن **لا** نوصي باستخدام Bun لتشغيل Gateway (مشكلات WhatsApp/Telegram).

لتبديل قنوات التحديث (تثبيتات git + npm):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

استخدم `--tag <dist-tag|version>` لتثبيت وسم/إصدار لمرة واحدة.

راجع [قنوات التطوير](/install/development-channels) لمعاني القنوات وملاحظات الإصدار.

ملاحظة: في تثبيتات npm، يسجّل Gateway تلميح تحديث عند بدء التشغيل (يتحقق من وسم القناة الحالية). عطّل ذلك عبر `update.checkOnStart: false`.

ثم:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

ملاحظات:

- إذا كان Gateway يعمل كخدمة، فـ `openclaw gateway restart` مُفضّل على قتل أرقام العمليات.
- إذا كنت مثبتًا على إصدار محدد، فراجع «التراجع / التثبيت» أدناه.

## التحديث (`openclaw update`)

بالنسبة إلى **تثبيتات المصدر** (git checkout)، يُفضّل:

```bash
openclaw update
```

يشغّل تدفق تحديث آمنًا نسبيًا:

- يتطلب شجرة عمل نظيفة.
- ينتقل إلى القناة المحددة (وسم أو فرع).
- يجلب التحديثات ويُعيد الدمج (rebase) مقابل upstream المُهيّأ (قناة التطوير).
- يثبّت الاعتمادات، ويبني، ويبني واجهة التحكم، ويشغّل `openclaw doctor`.
- يعيد تشغيل Gateway افتراضيًا (استخدم `--no-restart` للتخطي).

إذا ثبّتَّ عبر **npm/pnpm** (من دون بيانات git)، فسيحاول `openclaw update` التحديث عبر مدير الحزم لديك. إذا تعذّر عليه اكتشاف التثبيت، فاستخدم «التحديث (تثبيت عام)» بدلًا من ذلك.

## التحديث (واجهة التحكم / RPC)

تتضمن واجهة التحكم زر **Update & Restart** (RPC: `update.run`). وهو:

1. يشغّل تدفق تحديث المصدر نفسه مثل `openclaw update` (git checkout فقط).
2. يكتب إشارة إعادة تشغيل مع تقرير مُنظّم (ذيل stdout/stderr).
3. يعيد تشغيل Gateway ويُرسل التقرير إلى آخر جلسة نشطة.

إذا فشل rebase، يُجهِض Gateway العملية ويعيد التشغيل دون تطبيق التحديث.

## التحديث (من المصدر)

من دفع المستعرض:

المفضّل:

```bash
openclaw update
```

يدوي (مماثل تقريبًا):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

ملاحظات:

- `pnpm build` مهم عندما تشغّل الملف الثنائي المُعبّأ `openclaw` ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) أو تستخدم Node لتشغيل `dist/`.
- إذا كنت تشغّل من نسخة مستودع دون تثبيت عام، فاستخدم `pnpm openclaw ...` لأوامر CLI.
- إذا كنت تشغّل مباشرة من TypeScript (`pnpm openclaw ...`)، فإعادة البناء غالبًا غير ضرورية، لكن **ترحيلات التهيئة ما تزال مطبّقة** → شغّل doctor.
- التبديل بين التثبيت العام وتثبيت git سهل: ثبّت النكهة الأخرى، ثم شغّل `openclaw doctor` حتى يُعاد كتابة نقطة دخول خدمة Gateway إلى التثبيت الحالي.

## شغّل دائمًا: `openclaw doctor`

Doctor هو أمر «التحديث الآمن». إنه مملّ عمدًا: إصلاح + ترحيل + تحذير.

ملاحظة: إذا كنت على **تثبيت مصدر** (git checkout)، فسيعرض `openclaw doctor` تشغيل `openclaw update` أولًا.

أشياء نموذجية يقوم بها:

- ترحيل مفاتيح التهيئة المُهملة / مواقع ملفات التهيئة القديمة.
- تدقيق سياسات الرسائل الخاصة (DM) والتحذير من الإعدادات «المفتوحة» الخطِرة.
- فحص صحة Gateway وقد يعرض إعادة التشغيل.
- اكتشاف وترحيل خدمات Gateway الأقدم (launchd/systemd؛ schtasks القديمة) إلى خدمات OpenClaw الحالية.
- على Linux، التأكد من تمكين systemd user lingering (حتى يستمر Gateway بعد تسجيل الخروج).

التفاصيل: [Doctor](/gateway/doctor)

## بدء / إيقاف / إعادة تشغيل Gateway

CLI (يعمل بغضّ النظر عن نظام التشغيل):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

إذا كنت تستخدم إشراف الخدمات:

- macOS launchd (LaunchAgent مُضمّن بالتطبيق): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (استخدم `bot.molt.<profile>`؛ ولا يزال `com.openclaw.*` القديم يعمل)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - يعمل `launchctl`/`systemctl` فقط إذا كانت الخدمة مُثبّتة؛ وإلا فشغّل `openclaw gateway install`.

دليل التشغيل + تسميات الخدمات الدقيقة: [دليل تشغيل Gateway](/gateway)

## التراجع / التثبيت (عند توقف شيء)

### التثبيت (تثبيت عام)

ثبّت إصدارًا معروفًا يعمل (استبدل `<version>` بآخر إصدار كان يعمل):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

نصيحة: لمعرفة الإصدار المنشور الحالي، شغّل `npm view openclaw version`.

ثم أعد التشغيل وأعد تشغيل doctor:

```bash
openclaw doctor
openclaw gateway restart
```

### التثبيت (من المصدر) حسب التاريخ

اختر التزامًا (commit) من تاريخ معيّن (مثال: «حالة main بتاريخ 2026-01-01»):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

ثم أعد تثبيت الاعتمادات وأعد التشغيل:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

إذا أردت العودة إلى الأحدث لاحقًا:

```bash
git checkout main
git pull
```

## إذا علِقت

- شغّل `openclaw doctor` مرة أخرى واقرأ المخرجات بعناية (غالبًا ما تخبرك بالحل).
- تحقّق من: [استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting)
- اسأل في Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
