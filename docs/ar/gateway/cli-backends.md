---
summary: "الواجهات الخلفية لـ CLI: بديل نصّي فقط عبر واجهات سطر أوامر محلية للذكاء الاصطناعي"
read_when:
  - تريد بديلاً موثوقًا عند فشل موفّري واجهات API
  - تشغّل Claude Code CLI أو واجهات سطر أوامر محلية أخرى للذكاء الاصطناعي وتريد إعادة استخدامها
  - تحتاج مسارًا نصّيًا فقط وخاليًا من الأدوات مع الاستمرار في دعم الجلسات والصور
title: "الواجهات الخلفية لـ CLI"
---

# الواجهات الخلفية لـ CLI (بيئة تشغيل احتياطية)

يمكن لـ OpenClaw تشغيل **واجهات سطر أوامر محلية للذكاء الاصطناعي** كـ **بديل نصّي فقط** عند تعطل موفّري واجهات API،
أو فرض قيود المعدل، أو حدوث سلوك غير مستقر مؤقت. هذا الخيار محافظ عن قصد:

- **الأدوات معطّلة** (لا توجد استدعاءات أدوات).
- **نص داخل → نص خارج** (موثوق).
- **الجلسات مدعومة** (للحفاظ على تماسك الردود اللاحقة).
- **يمكن تمرير الصور** إذا كان الـ CLI يقبل مسارات الصور.

صُمّم هذا كـ **شبكة أمان** وليس مسارًا أساسيًا. استخدمه عندما
تريد ردودًا نصّية «تعمل دائمًا» دون الاعتماد على واجهات API خارجية.

## بدء سريع مناسب للمبتدئين

يمكنك استخدام Claude Code CLI **من دون أي تهيئة** (يشحن OpenClaw إعدادًا افتراضيًا مدمجًا):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

يعمل Codex CLI أيضًا مباشرة دون إعداد:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

إذا كان Gateway يعمل تحت launchd/systemd وكان PATH محدودًا، فأضف فقط
مسار الأمر:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

هذا كل شيء. لا مفاتيح، ولا إعداد مصادقة إضافي مطلوب beyond الـ CLI نفسه.

## استخدامه كخيار احتياطي

أضف واجهة CLI خلفية إلى قائمة البدائل بحيث تعمل فقط عند فشل النماذج الأساسية:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

ملاحظات:

- إذا استخدمت `agents.defaults.models` (قائمة السماح)، فيجب تضمين `claude-cli/...`.
- إذا فشل الموفّر الأساسي (مصادقة، حدود المعدل، مهلات)، فسيحاول OpenClaw
  الواجهة الخلفية لـ CLI بعد ذلك.

## نظرة عامة على التهيئة

توجد جميع الواجهات الخلفية لـ CLI ضمن:

```
agents.defaults.cliBackends
```

يتم تمييز كل إدخال بواسطة **معرّف موفّر** (مثل `claude-cli`، `my-cli`).
ويصبح معرّف الموفّر هو الجزء الأيسر من مرجع النموذج لديك:

```
<provider>/<model>
```

### مثال على التهيئة

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## كيف يعمل

1. **يختار واجهة خلفية** بناءً على بادئة الموفّر (`claude-cli/...`).
2. **يبني مطالبة النظام** باستخدام نفس مطالبة OpenClaw مع سياق مساحة العمل.
3. **ينفّذ الـ CLI** مع معرّف جلسة (إن كان مدعومًا) للحفاظ على اتساق السجل.
4. **يحلّل المخرجات** (JSON أو نص عادي) ويعيد النص النهائي.
5. **يحفظ معرّفات الجلسات** لكل واجهة خلفية، بحيث تعيد المتابعات استخدام نفس جلسة الـ CLI.

## الجلسات

- إذا كان الـ CLI يدعم الجلسات، فاضبط `sessionArg` (مثل `--session-id`) أو
  `sessionArgs` (عنصر نائب `{sessionId}`) عندما يلزم إدراج المعرّف
  في عدة أعلام.
- إذا كان الـ CLI يستخدم **أمرًا فرعيًا للاستئناف** مع أعلام مختلفة، فاضبط
  `resumeArgs` (يستبدل `args` عند الاستئناف) ويمكنك اختياريًا ضبط `resumeOutput`
  (لاستئنافات غير JSON).
- `sessionMode`:
  - `always`: إرسال معرّف جلسة دائمًا (UUID جديد إذا لم يكن مخزّنًا).
  - `existing`: إرسال معرّف جلسة فقط إذا كان مخزّنًا سابقًا.
  - `none`: عدم إرسال معرّف جلسة مطلقًا.

## الصور (تمرير مباشر)

إذا كان الـ CLI يقبل مسارات الصور، فاضبط `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

سيكتب OpenClaw الصور المرمّزة base64 إلى ملفات مؤقتة. إذا كان `imageArg` مضبوطًا،
فسيتم تمرير تلك المسارات كوسائط للـ CLI. إذا كان `imageArg` مفقودًا،
فسيُلحق OpenClaw مسارات الملفات بالمطالبة (حقن المسار)، وهو ما يكفي
لواجهات CLI التي تحمّل الملفات المحلية تلقائيًا من المسارات النصية العادية
(سلوك Claude Code CLI).

## الإدخالات / المخرجات

- يحاول `output: "json"` (الافتراضي) تحليل JSON واستخراج النص + معرّف الجلسة.
- يحلل `output: "jsonl"` تدفقات JSONL (Codex CLI `--json`) ويستخرج
  آخر رسالة للوكيل إضافةً إلى `thread_id` عند توفره.
- يعامل `output: "text"` stdout على أنه الاستجابة النهائية.

أوضاع الإدخال:

- يمرّر `input: "arg"` (الافتراضي) المطالبة كآخر وسيط للـ CLI.
- يرسل `input: "stdin"` المطالبة عبر stdin.
- إذا كانت المطالبة طويلة جدًا وتم ضبط `maxPromptArgChars`، فسيُستخدم stdin.

## الإعدادات الافتراضية (المدمجة)

يشحن OpenClaw إعدادًا افتراضيًا لـ `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

كما يشحن OpenClaw إعدادًا افتراضيًا لـ `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

قم بالتجاوز فقط عند الحاجة (الشائع: مسار `command` مطلق).

## القيود

- **لا توجد أدوات OpenClaw** (الواجهة الخلفية لـ CLI لا تتلقى استدعاءات أدوات). قد
  تشغّل بعض واجهات CLI أدواتها الوكيلة الخاصة.
- **لا يوجد بث** (يتم جمع مخرجات الـ CLI ثم إرجاعها).
- **المخرجات المهيكلة** تعتمد على تنسيق JSON الخاص بالـ CLI.
- **جلسات Codex CLI** تُستأنف عبر مخرجات نصية (من دون JSONL)، وهو أقل
  تنظيمًا من تشغيل `--json` الأولي. تعمل جلسات OpenClaw بشكل طبيعي.

## استكشاف الأخطاء وإصلاحها

- **لم يتم العثور على CLI**: اضبط `command` على مسار كامل.
- **اسم نموذج غير صحيح**: استخدم `modelAliases` لربط `provider/model` → نموذج CLI.
- **لا يوجد استمرارية للجلسة**: تأكّد من ضبط `sessionArg` وأن `sessionMode` ليس
  `none` (لا يمكن لـ Codex CLI حاليًا الاستئناف مع مخرجات JSON).
- **الصور مُتجاهلة**: اضبط `imageArg` (وتحقق من أن الـ CLI يدعم مسارات الملفات).
