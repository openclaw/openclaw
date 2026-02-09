---
summary: "Skills: المُدارة مقابل مساحة العمل، قواعد التقييد، وربط التهيئة/البيئة"
read_when:
  - إضافة Skills أو تعديلها
  - تغيير تقييد Skills أو قواعد التحميل
title: "Skills"
---

# Skills (OpenClaw)

يستخدم OpenClaw مجلدات Skills المتوافقة مع **[AgentSkills](https://agentskills.io)** لتعليم الوكيل كيفية استخدام الأدوات. كل Skill هي دليل يحتوي على `SKILL.md` مع واجهة أمامية YAML وتعليمات. يقوم OpenClaw بتحميل **Skills المضمّنة** إضافةً إلى تجاوزات محلية اختيارية، ويقوم بتصفيتها وقت التحميل بناءً على البيئة والتهيئة ووجود الملفات التنفيذية.

## المواقع والأولوية

يتم تحميل Skills من **ثلاثة** أماكن:

1. **Skills المضمّنة**: المشحونة مع التثبيت (حزمة npm أو OpenClaw.app)
2. **Skills المُدارة/المحلية**: `~/.openclaw/skills`
3. **Skills مساحة العمل**: `<workspace>/skills`

إذا تعارض اسم Skill، تكون الأولوية كما يلي:

`<workspace>/skills` (الأعلى) → `~/.openclaw/skills` → Skills المضمّنة (الأدنى)

بالإضافة إلى ذلك، يمكنك تهيئة مجلدات Skills إضافية (بأدنى أولوية) عبر
`skills.load.extraDirs` في `~/.openclaw/openclaw.json`.

## Skills لكل وكيل مقابل Skills مشتركة

في إعدادات **متعددة الوكلاء**، يمتلك كل وكيل مساحة عمل خاصة به. هذا يعني:

- **Skills لكل وكيل** تعيش في `<workspace>/skills` لذلك الوكيل فقط.
- **Skills المشتركة** تعيش في `~/.openclaw/skills` (مُدارة/محلية) وتكون مرئية
  **لجميع الوكلاء** على نفس الجهاز.
- يمكن أيضًا إضافة **مجلدات مشتركة** عبر `skills.load.extraDirs` (أدنى أولوية)
  إذا رغبت في حزمة Skills مشتركة تُستخدم من قِبل عدة وكلاء.

إذا وُجد نفس اسم Skill في أكثر من مكان، تنطبق أولوية التحميل المعتادة:
تفوز مساحة العمل، ثم المُدارة/المحلية، ثم المضمّنة.

## الإضافات + Skills

يمكن للإضافات شحن Skills خاصة بها عبر إدراج دلائل `skills` في
`openclaw.plugin.json` (مسارات نسبية إلى جذر الإضافة). يتم تحميل Skills الإضافة
عند تمكين الإضافة وتشارك في قواعد أولوية Skills المعتادة.
يمكنك تقييدها عبر `metadata.openclaw.requires.config` على مُدخل تهيئة الإضافة. انظر [Plugins](/tools/plugin) للاكتشاف/التهيئة و[Tools](/tools) لواجهة
الأدوات التي تُعلّمها تلك Skills.

## ClawHub (التثبيت + المزامنة)

ClawHub هو سجل Skills العام لـ OpenClaw. تصفّح على
[https://clawhub.com](https://clawhub.com). استخدمه لاكتشاف Skills وتثبيتها وتحديثها والنسخ الاحتياطي لها.
الدليل الكامل: [ClawHub](/tools/clawhub).

التدفقات المشتركة:

- تثبيت Skill في مساحة العمل:
  - `clawhub install <skill-slug>`
- تحديث جميع Skills المثبّتة:
  - `clawhub update --all`
- المزامنة (فحص + نشر التحديثات):
  - `clawhub sync --all`

افتراضيًا، يقوم `clawhub` بالتثبيت في `./skills` ضمن دليل العمل الحالي
(أو يعود إلى مساحة عمل OpenClaw المُهيّأة). يلتقط OpenClaw ذلك على أنه
`<workspace>/skills` في الجلسة التالية.

## ملاحظات أمنية

- اعتبر Skills التابعة لجهات خارجية **شيفرة غير موثوقة**. اقرأها قبل التمكين.
- فضّل التشغيل داخل sandbox للمدخلات غير الموثوقة والأدوات عالية المخاطر. انظر [Sandboxing](/gateway/sandboxing).
- يقوم `skills.entries.*.env` و`skills.entries.*.apiKey` بحقن الأسرار في عملية **المضيف**
  لذلك الدور من الوكيل (وليس داخل sandbox). أبقِ الأسرار خارج المطالبات والسجلات.
- لنموذج تهديد أوسع وقوائم تحقق، انظر [Security](/gateway/security).

## الصيغة (AgentSkills + متوافقة مع Pi)

يجب أن يتضمن `SKILL.md` على الأقل:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

ملاحظات:

- نتبع مواصفة AgentSkills من حيث التخطيط والغاية.
- المحلّل المستخدم من قِبل الوكيل المضمّن يدعم مفاتيح واجهة أمامية **بسطر واحد** فقط.
- يجب أن يكون `metadata` **كائن JSON بسطر واحد**.
- استخدم `{baseDir}` في التعليمات للإشارة إلى مسار مجلد Skill.
- مفاتيح واجهة أمامية اختيارية:
  - `homepage` — عنوان URL يُعرض كـ «Website» في واجهة Skills على macOS (مدعوم أيضًا عبر `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (الافتراضي: `true`). عند `true`، تُعرَض Skill كأمر مائل للمستخدم.
  - `disable-model-invocation` — `true|false` (الافتراضي: `false`). عند `true`، تُستبعد Skill من مطالبة النموذج (وتظل متاحة عبر استدعاء المستخدم).
  - `command-dispatch` — `tool` (اختياري). عند التعيين إلى `tool`، يتجاوز الأمر المائل النموذج ويُرسل مباشرةً إلى أداة.
  - `command-tool` — اسم الأداة التي سيتم استدعاؤها عند تعيين `command-dispatch: tool`.
  - `command-arg-mode` — `raw` (الافتراضي). لإرسال الأداة، يمرّر سلسلة الوسائط الخام إلى الأداة (دون تحليل أساسي).

    تُستدعى الأداة مع المعاملات:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## التقييد (مرشحات وقت التحميل)

يقوم OpenClaw **بتصفية Skills وقت التحميل** باستخدام `metadata` (JSON بسطر واحد):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

الحقول ضمن `metadata.openclaw`:

- `always: true` — تضمين Skill دائمًا (تجاوز بقية القيود).
- `emoji` — إيموجي اختياري تستخدمه واجهة Skills على macOS.
- `homepage` — عنوان URL اختياري يُعرض كـ «Website» في واجهة Skills على macOS.
- `os` — قائمة اختيارية بالمنصات (`darwin`، `linux`، `win32`). إذا عُيّنت، تكون Skill مؤهلة فقط على تلك أنظمة التشغيل.
- `requires.bins` — قائمة؛ يجب أن يوجد كل عنصر على `PATH`.
- `requires.anyBins` — قائمة؛ يجب أن يوجد عنصر واحد على الأقل على `PATH`.
- `requires.env` — قائمة؛ يجب أن يوجد متغير البيئة **أو** يُقدَّم في التهيئة.
- `requires.config` — قائمة بمسارات `openclaw.json` يجب أن تكون صحيحة.
- `primaryEnv` — اسم متغير البيئة المرتبط بـ `skills.entries.<name>.apiKey`.
- `install` — مصفوفة اختيارية من مواصفات المُثبّت المستخدمة بواسطة واجهة Skills على macOS (brew/node/go/uv/download).

ملاحظة حول sandboxing:

- يتم التحقق من `requires.bins` على **المضيف** وقت تحميل Skill.
- إذا كان الوكيل يعمل داخل sandbox، فيجب أن يكون الملف التنفيذي موجودًا أيضًا **داخل الحاوية**.
  قم بتثبيته عبر `agents.defaults.sandbox.docker.setupCommand` (أو صورة مخصّصة).
  يتم تشغيل `setupCommand` مرة واحدة بعد إنشاء الحاوية.
  تتطلب عمليات تثبيت الحِزم أيضًا خروج شبكة، ونظام ملفات جذر قابل للكتابة، ومستخدم جذر داخل sandbox.
  مثال: Skill `summarize` (`skills/summarize/SKILL.md`) تحتاج إلى CLI الخاص بـ `summarize`
  داخل حاوية sandbox لتعمل هناك.

مثال على المُثبّت:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

ملاحظات:

- إذا سُردت عدة مُثبّتات، تختار البوابة خيارًا **واحدًا** مفضّلًا (brew عند توفره، وإلا node).
- إذا كانت جميع المُثبّتات `download`، يسرد OpenClaw كل إدخال لتتمكّن من رؤية العناصر المتاحة.
- يمكن أن تتضمن مواصفات المُثبّت `os: ["darwin"|"linux"|"win32"]` لتصفية الخيارات حسب المنصة.
- تحترم عمليات تثبيت Node قيمة `skills.install.nodeManager` في `openclaw.json` (الافتراضي: npm؛ الخيارات: npm/pnpm/yarn/bun).
  يؤثر هذا على **تثبيت Skills** فقط؛ يجب أن يبقى تشغيل Gateway هو Node
  (لا يُنصح بـ Bun لـ WhatsApp/Telegram).
- تثبيت Go: إذا كان `go` مفقودًا وكان `brew` متاحًا، تقوم البوابة بتثبيت Go عبر Homebrew أولًا وتعيّن `GOBIN` إلى `bin` الخاص بـ Homebrew عندما يكون ذلك ممكنًا.
- تثبيت التنزيل: `url` (مطلوب)، `archive` (`tar.gz` | `tar.bz2` | `zip`)، `extract` (الافتراضي: تلقائي عند اكتشاف أرشيف)، `stripComponents`، `targetDir` (الافتراضي: `~/.openclaw/tools/<skillKey>`).

إذا لم يوجد `metadata.openclaw`، تكون Skill مؤهلة دائمًا (ما لم تُعطّل في التهيئة أو تُحجب بواسطة `skills.allowBundled` لـ Skills المضمّنة).

## تجاوزات التهيئة (`~/.openclaw/openclaw.json`)

يمكن تبديل Skills المضمّنة/المُدارة وتزويدها بقيم بيئية:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

ملاحظة: إذا كان اسم Skill يحتوي على شرطات، ضع المفتاح بين علامتي اقتباس (JSON5 يسمح بالمفاتيح المقتبسة).

تطابق مفاتيح التهيئة **اسم Skill** افتراضيًا. إذا عرّفت Skill
`metadata.openclaw.skillKey`، فاستخدم ذلك المفتاح ضمن `skills.entries`.

القواعد:

- `enabled: false` يعطّل Skill حتى لو كانت مضمّنة/مثبّتة.
- `env`: تُحقن **فقط إذا** لم يكن المتغير مضبوطًا مسبقًا في العملية.
- `apiKey`: تسهيل للـ Skills التي تعلن `metadata.openclaw.primaryEnv`.
- `config`: حاوية اختيارية لحقول مخصّصة لكل Skill؛ يجب أن تعيش المفاتيح المخصّصة هنا.
- `allowBundled`: قائمة سماح اختيارية لـ Skills **المضمّنة** فقط. إذا عُيّنت، تكون Skills المضمّنة المدرجة فقط مؤهلة (ولا تتأثر Skills المُدارة/مساحة العمل).

## حقن البيئة (لكل تشغيل وكيل)

عند بدء تشغيل وكيل، يقوم OpenClaw بما يلي:

1. قراءة بيانات Skills الوصفية.
2. تطبيق أي `skills.entries.<key>.env` أو `skills.entries.<key>.apiKey` على
   `process.env`.
3. بناء مطالبة النظام مع Skills **المؤهلة**.
4. استعادة البيئة الأصلية بعد انتهاء التشغيل.

هذا **مقيّد بتشغيل الوكيل**، وليس بيئة صدفة عامة.

## لقطة الجلسة (الأداء)

يلتقط OpenClaw لقطة لِـ Skills المؤهلة **عند بدء الجلسة** ويعيد استخدام تلك القائمة للأدوار اللاحقة ضمن الجلسة نفسها. تسري التغييرات على Skills أو التهيئة مع الجلسة الجديدة التالية.

يمكن أيضًا تحديث Skills في منتصف الجلسة عند تمكين مراقب Skills أو عند ظهور عُقدة بعيدة مؤهلة جديدة (انظر أدناه). فكّر في ذلك كـ **إعادة تحميل ساخنة**: تُلتقط القائمة المحدّثة في دور الوكيل التالي.

## عُقد macOS بعيدة (Gateway على Linux)

إذا كانت Gateway تعمل على Linux لكن **عُقدة macOS** متصلة **مع السماح بـ `system.run`**
(عدم ضبط أمان موافقات Exec على `deny`)، يمكن لـ OpenClaw
اعتبار Skills الخاصة بـ macOS مؤهلة عندما تكون الملفات التنفيذية المطلوبة موجودة على تلك العُقدة. ينبغي على الوكيل تنفيذ تلك Skills عبر أداة `nodes` (عادةً `nodes.run`).

يعتمد ذلك على قيام العُقدة بالإبلاغ عن دعم الأوامر وعلى فحص الملفات التنفيذية عبر `system.run`. إذا أصبحت عُقدة macOS غير متصلة لاحقًا، تبقى Skills مرئية؛ وقد تفشل الاستدعاءات حتى تعاود العُقدة الاتصال.

## مراقب Skills (تحديث تلقائي)

افتراضيًا، يراقب OpenClaw مجلدات Skills ويُحدّث لقطة Skills عندما تتغير ملفات `SKILL.md`. قم بتهيئة ذلك ضمن `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## تأثير الرموز (قائمة Skills)

عندما تكون Skills مؤهلة، يحقن OpenClaw قائمة XML مضغوطة بالـ Skills المتاحة في مطالبة النظام (عبر `formatSkillsForPrompt` في `pi-coding-agent`). التكلفة حتمية:

- **العبء الأساسي (فقط عند وجود ≥1 Skill):** 195 حرفًا.
- **لكل Skill:** 97 حرفًا + طول القيم المُهربة بصيغة XML لكل من `<name>` و`<description>` و`<location>`.

الصيغة (عدد الأحرف):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

ملاحظات:

- يؤدي تهريب XML إلى توسيع `& < > " '` إلى كيانات (`&amp;`، `&lt;`، إلخ)، مما يزيد الطول.
- تختلف أعداد الرموز حسب مُجزّئ النموذج. تقدير تقريبي بأسلوب OpenAI هو ~4 أحرف/رمز، لذا **97 حرفًا ≈ 24 رمزًا** لكل Skill بالإضافة إلى أطوال الحقول الفعلية.

## دورة حياة Skills المُدارة

يشحن OpenClaw مجموعة أساسية من Skills على أنها **Skills مضمّنة** كجزء من
التثبيت (حزمة npm أو OpenClaw.app). يوجد `~/.openclaw/skills` لتجاوزات محلية
(على سبيل المثال، تثبيت/ترقيع Skill دون تغيير النسخة المضمّنة). Skills مساحة العمل مملوكة للمستخدم وتتجاوز كليهما عند تعارض الأسماء.

## مرجع التهيئة

انظر [Skills config](/tools/skills-config) لمخطط التهيئة الكامل.

## هل تبحث عن المزيد من Skills؟

تصفّح [https://clawhub.com](https://clawhub.com).

---
