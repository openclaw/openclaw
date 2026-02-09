---
summary: "خطوات التوقيع لبُنى تصحيح الأخطاء على macOS التي تُنشئها سكربتات التغليف"
read_when:
  - بناء أو توقيع بُنى تصحيح الأخطاء على mac
title: "توقيع macOS"
---

# توقيع mac (بُنى تصحيح الأخطاء)

يتم عادةً بناء هذا التطبيق من [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)، والذي يقوم الآن بما يلي:

- يضبط معرّف حزمة تصحيح أخطاء ثابتًا: `ai.openclaw.mac.debug`
- يكتب ملف Info.plist بهذا المعرّف (يمكن التجاوز عبر `BUNDLE_ID=...`)
- يستدعي [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) لتوقيع الملف التنفيذي الرئيسي وحزمة التطبيق بحيث يتعامل macOS مع كل إعادة بناء على أنها نفس الحزمة الموقّعة ويحافظ على أذونات TCC (الإشعارات، إمكانية الوصول، تسجيل الشاشة، الميكروفون، الكلام). ولثبات الأذونات، استخدم هوية توقيع حقيقية؛ التوقيع المخصّص (ad‑hoc) اختياري وهشّ (انظر [أذونات macOS](/platforms/mac/permissions)).
- يستخدم `CODESIGN_TIMESTAMP=auto` افتراضيًا؛ وهو يفعّل الطوابع الزمنية الموثوقة لتواقيع Developer ID. عيّن `CODESIGN_TIMESTAMP=off` لتخطي وضع الطابع الزمني (لبُنى تصحيح الأخطاء دون اتصال).
- يحقن بيانات وصفية للبناء في Info.plist: `OpenClawBuildTimestamp` (UTC) و`OpenClawGitCommit` (تجزئة قصيرة) بحيث يمكن لجزء «حول» عرض معلومات البناء وgit وقناة التصحيح/الإصدار.
- **يتطلب التغليف Node 22+**: إذ يشغّل السكربت عمليات بناء TS وبناء واجهة التحكم.
- يقرأ `SIGN_IDENTITY` من البيئة. أضِف `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (أو شهادة Developer ID Application الخاصة بك) إلى ملف rc الخاص بالصدفة لديك للتوقيع دائمًا بشهادتك. يتطلب التوقيع المخصّص (ad‑hoc) تفعيلًا صريحًا عبر `ALLOW_ADHOC_SIGNING=1` أو `SIGN_IDENTITY="-"` (غير موصى به لاختبار الأذونات).
- يجري تدقيق Team ID بعد التوقيع ويفشل إذا كان أي ملف Mach‑O داخل حزمة التطبيق موقّعًا بمعرّف فريق مختلف. عيّن `SKIP_TEAM_ID_CHECK=1` للتجاوز.

## الاستخدام

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### ملاحظة حول التوقيع المخصّص (Ad-hoc)

عند التوقيع باستخدام `SIGN_IDENTITY="-"` (ad‑hoc)، يقوم السكربت تلقائيًا بتعطيل **Hardened Runtime** (`--options runtime`). هذا ضروري لمنع الأعطال عندما يحاول التطبيق تحميل أطر مضمّنة (مثل Sparkle) لا تشترك في نفس Team ID. كما أن التواقيع المخصّصة تكسر استمرارية أذونات TCC؛ راجع [أذونات macOS](/platforms/mac/permissions) لخطوات الاستعادة.

## إنشاء بيانات التعريف لـ حول

يقوم `package-mac-app.sh` بختم الحزمة بما يلي:

- `OpenClawBuildTimestamp`: ISO8601 بتوقيت UTC وقت التغليف
- `OpenClawGitCommit`: تجزئة git قصيرة (أو `unknown` إذا لم تكن متاحة)

تقرأ علامة التبويب «حول» هذه المفاتيح لعرض الإصدار وتاريخ البناء والتزام git وما إذا كان البناء تصحيح أخطاء (عبر `#if DEBUG`). شغّل أداة التغليف لتحديث هذه القيم بعد تغييرات الشيفرة.

## لماذا

ترتبط أذونات TCC بمعرّف الحزمة _وبالتوقيع البرمجي_. كانت بُنى تصحيح الأخطاء غير الموقّعة ذات UUIDs المتغيّرة تتسبب في نسيان macOS للأذونات بعد كل إعادة بناء. إن توقيع الملفات التنفيذية (ad‑hoc افتراضيًا) والحفاظ على معرّف/مسار حزمة ثابت (`dist/OpenClaw.app`) يحافظان على الأذونات بين عمليات البناء، بما يطابق نهج VibeTunnel.
