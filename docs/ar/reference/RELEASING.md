---
summary: "قائمة تدقيق خطوة بخطوة للإصدار عبر npm + تطبيق macOS"
read_when:
  - عند قطع إصدار npm جديد
  - عند قطع إصدار جديد لتطبيق macOS
  - التحقق من البيانات الوصفية قبل النشر
---

# قائمة تدقيق الإصدار (npm + macOS)

استخدم `pnpm` (Node 22+) من جذر المستودع. احرص على أن تكون شجرة العمل نظيفة قبل وضع الوسوم/النشر.

## مشغل المشغل

عندما يقول المشغّل «release»، نفّذ فورًا فحص ما قبل التنفيذ التالي (من دون أسئلة إضافية إلا إذا وُجد عائق):

- اقرأ هذا المستند و `docs/platforms/mac/release.md`.
- حمّل متغيرات البيئة من `~/.profile` وتأكد من ضبط `SPARKLE_PRIVATE_KEY_FILE` + متغيرات App Store Connect (يجب أن يوجد SPARKLE_PRIVATE_KEY_FILE في `~/.profile`).
- استخدم مفاتيح Sparkle من `~/Library/CloudStorage/Dropbox/Backup/Sparkle` عند الحاجة.

1. **الإصدار والبيانات الوصفية**

- [ ] زيادة إصدار `package.json` (مثلًا: `2026.1.29`).
- [ ] شغّل `pnpm plugins:sync` لمواءمة إصدارات حزم الامتدادات + سجلات التغييرات.
- [ ] حدّث سلاسل CLI/الإصدار: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) ووكيل مستخدم Baileys في [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] أكّد بيانات الحزمة الوصفية (الاسم، الوصف، المستودع، الكلمات المفتاحية، الرخصة) وأن خريطة `bin` تشير إلى [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) لـ `openclaw`.
- [ ] إذا تغيّرت التبعيات، شغّل `pnpm install` بحيث تكون `pnpm-lock.yaml` مُحدَّثة.

2. **البناء والمُخرجات**

- [ ] إذا تغيّرت مدخلات A2UI، شغّل `pnpm canvas:a2ui:bundle` وثبّت أي تحديثات على [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (يعيد توليد `dist/`).
- [ ] تحقّق من أن حزمة npm `files` تتضمن جميع مجلدات `dist/*` المطلوبة (وخاصة `dist/node-host/**` و `dist/acp/**` لعقدة بدون واجهة + ACP CLI).
- [ ] تأكّد من وجود `dist/build-info.json` وأنه يتضمن تجزئة `commit` المتوقعة (يستخدمها شعار CLI لتثبيتات npm).
- [ ] اختياري: `npm pack --pack-destination /tmp` بعد البناء؛ افحص محتويات ملف tarball واحتفظ به لإصدار GitHub (لا تقم بتثبيته في المستودع).

3. **سجل التغييرات والوثائق**

- [ ] حدّث `CHANGELOG.md` مع أبرز النقاط الموجّهة للمستخدم (أنشئ الملف إن لم يكن موجودًا)؛ حافظ على ترتيب الإدخالات تنازليًا حسب الإصدار.
- [ ] تأكّد من أن أمثلة README/الأعلام تطابق سلوك CLI الحالي (لا سيما الأوامر أو الخيارات الجديدة).

4. **التحقّق**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (أو `pnpm test:coverage` إذا كنت تحتاج مخرجات التغطية)
- [ ] `pnpm release:check` (يتحقق من محتويات npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (اختبار دخاني لتثبيت Docker، المسار السريع؛ مطلوب قبل الإصدار)
  - إذا كان إصدار npm السابق مباشرةً معروفًا بأنه معطّل، اضبط `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` أو `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` لخطوة preinstall.
- [ ] (اختياري) اختبار دخاني كامل للمُثبّت (يضيف تغطية مستخدم غير الجذر + CLI): `pnpm test:install:smoke`
- [ ] (اختياري) اختبار E2E للمُثبّت (Docker، يشغّل `curl -fsSL https://openclaw.ai/install.sh | bash`، يُجري التهيئة الأولية، ثم يشغّل استدعاءات أدوات حقيقية):
  - `pnpm test:install:e2e:openai` (يتطلب `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (يتطلب `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (يتطلب كلا المفتاحين؛ يشغّل كلا الموفّرين)
- [ ] (اختياري) فحص سريع لبوابة الويب إذا كانت تغييراتك تؤثر في مسارات الإرسال/الاستقبال.

5. **تطبيق macOS (Sparkle)**

- [ ] ابنِ تطبيق macOS ووقّعه، ثم اضغطه للتوزيع.
- [ ] أنشئ appcast لـ Sparkle (ملاحظات HTML عبر [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) وحدّث `appcast.xml`.
- [ ] احتفظ بملف zip للتطبيق (وملف dSYM zip الاختياري) جاهزًا للإرفاق بإصدار GitHub.
- [ ] اتبع [إصدار macOS](/platforms/mac/release) للأوامر الدقيقة ومتغيرات البيئة المطلوبة.
  - يجب أن يكون `APP_BUILD` رقميًا وأحادي الزيادة (من دون `-beta`) حتى يقارن Sparkle الإصدارات بشكل صحيح.
  - عند التوثيق، استخدم ملف تعريف سلسلة المفاتيح `openclaw-notary` المُنشأ من متغيرات بيئة واجهة App Store Connect البرمجية (راجع [إصدار macOS](/platforms/mac/release)).

6. **النشر (npm)**

- [ ] تأكيد حالة git نظيفة؛ الالتزام والدفع حسب الحاجة.
- [ ] `npm login` (تحقّق من 2FA) عند الحاجة.
- [ ] `npm publish --access public` (استخدم `--tag beta` للإصدارات ما قبل النهائية).
- [ ] تحقّق من السجل: `npm view openclaw version`، `npm view openclaw dist-tags`، و `npx -y openclaw@X.Y.Z --version` (أو `--help`).

### استكشاف الأخطاء وإصلاحها (ملاحظات من إصدار 2.0.0-beta2)

- **تعليق npm pack/publish أو إنتاج tarball ضخم**: يتم سحب حزمة تطبيق macOS في `dist/OpenClaw.app` (وحِزَم الإصدار المضغوطة) إلى داخل الحزمة. عالج ذلك عبر إدراج محتويات النشر في القائمة البيضاء باستخدام `package.json` `files` (تضمين مجلدات dist الفرعية، والوثائق، و skills؛ واستبعاد حِزَم التطبيقات). أكّد عبر `npm pack --dry-run` أن `dist/OpenClaw.app` غير مُدرج.
- **حلقة مصادقة npm عبر الويب لوسوم التوزيع**: استخدم المصادقة القديمة للحصول على مطالبة OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **فشل التحقق من `npx` مع `ECOMPROMISED: Lock compromised`**: أعد المحاولة مع ذاكرة تخزين مؤقتة جديدة:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **الحاجة إلى إعادة توجيه الوسم بعد إصلاح متأخر**: حدّث الوسم قسرًا وادفعه، ثم تأكّد من أن أصول إصدار GitHub ما زالت متطابقة:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **إصدار GitHub + appcast**

- [ ] ضع الوسم وادفعه: `git tag vX.Y.Z && git push origin vX.Y.Z` (أو `git push --tags`).
- [ ] أنشئ/حدّث إصدار GitHub لـ `vX.Y.Z` بعنوان **`openclaw X.Y.Z`** (وليس الوسم فقط)؛ يجب أن يتضمن المتن قسم سجل التغييرات **الكامل** لذلك الإصدار (أبرز النقاط + التغييرات + الإصلاحات)، مضمّنًا (من دون روابط مجردة)، و**يجب ألا يكرر العنوان داخل المتن**.
- [ ] أرفق المُخرجات: ملف tarball لـ `npm pack` (اختياري)، و `OpenClaw-X.Y.Z.zip`، و `OpenClaw-X.Y.Z.dSYM.zip` (إن تم توليدهما).
- [ ] ثبّت وادفع `appcast.xml` المُحدَّث (تغذّي Sparkle من الفرع main).
- [ ] من دليل مؤقت نظيف (من دون `package.json`)، شغّل `npx -y openclaw@X.Y.Z send --help` للتأكد من عمل التثبيت/نقاط دخول CLI.
- [ ] أعلن/شارك ملاحظات الإصدار.

## نطاق نشر الإضافات (npm)

ننشر فقط **إضافات npm الموجودة مسبقًا** ضمن نطاق `@openclaw/*`. الإضافات المضمّنة التي ليست على npm تبقى **على شجرة القرص فقط** (ولا تزال تُشحن ضمن `extensions/**`).

عملية استخلاص القائمة:

1. `npm search @openclaw --json` والتقط أسماء الحزم.
2. قارن مع أسماء `extensions/*/package.json`.
3. انشر فقط **التقاطع** (الموجود بالفعل على npm).

قائمة إضافات npm الحالية (حدّث حسب الحاجة):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

يجب أن تُبرز ملاحظات الإصدار أيضًا **الإضافات المضمّنة الاختيارية الجديدة** التي **ليست مفعّلة افتراضيًا** (مثال: `tlon`).
