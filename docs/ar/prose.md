---
summary: "OpenProse: سير عمل ‎.prose‎، أوامر الشرطة المائلة، والحالة في OpenClaw"
read_when:
  - تريد تشغيل أو كتابة سير عمل ‎.prose‎
  - تريد تمكين إضافة OpenProse
  - تحتاج إلى فهم تخزين الحالة
title: "OpenProse"
---

# OpenProse

OpenProse هو تنسيق سير عمل محمول يعتمد على Markdown أولًا لتنسيق جلسات الذكاء الاصطناعي. في OpenClaw يأتي كإضافة تقوم بتثبيت حزمة Skills لـ OpenProse بالإضافة إلى أمر شرطة مائلة `/prose`. تعيش البرامج داخل ملفات `.prose` ويمكنها إنشاء عدة وكلاء فرعيين مع تحكم صريح في تدفّق التنفيذ.

الموقع الرسمي: [https://www.prose.md](https://www.prose.md)

## ما الذي يمكنه فعله

- البحوث المتعددة العوامل + التوليف بالتوازي الواضح.
- سير عمل قابلة للتكرار وآمنة للموافقات (مراجعة الشيفرة، فرز الحوادث، مسارات المحتوى).
- برامج `.prose` قابلة لإعادة الاستخدام يمكنك تشغيلها عبر بيئات تشغيل الوكلاء المدعومة.

## التثبيت والتمكين

الإضافات المجمّعة معطّلة افتراضيًا. لتمكين OpenProse:

```bash
openclaw plugins enable open-prose
```

أعد تشغيل Gateway (البوابة) بعد تمكين الإضافة.

للتطوير/التحقق المحلي: `openclaw plugins install ./extensions/open-prose`

مستندات ذات صلة: [Plugins](/tools/plugin)، [Plugin manifest](/plugins/manifest)، [Skills](/tools/skills).

## أمر Slash

يسجّل OpenProse الأمر `/prose` كأمر Skills يمكن للمستخدم استدعاؤه. يوجّه هذا الأمر إلى تعليمات آلة OpenProse الافتراضية ويستخدم أدوات OpenClaw من الداخل.

الأوامر الشائعة:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## مثال: ملف `.prose` بسيط

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## مواقع الملفات

يحفظ OpenProse الحالة ضمن `.prose/` في مساحة العمل لديك:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

توجد الوكلاء الدائمون على مستوى المستخدم في:

```
~/.prose/agents/
```

## أوضاع الدولة

يدعم OpenProse عدة خلفيات للحالة:

- **filesystem** (الافتراضي): `.prose/runs/...`
- **in-context**: مؤقت، للبرامج الصغيرة
- **sqlite** (تجريبي): يتطلب الملف التنفيذي `sqlite3`
- **postgres** (تجريبي): يتطلب `psql` وسلسلة اتصال

ملاحظات:

- sqlite/postgres خيارات اختيارية وتجريبية.
- تنتقل بيانات اعتماد postgres إلى سجلات الوكلاء الفرعيين؛ استخدم قاعدة بيانات مخصصة وبأقل الامتيازات.

## البرامج البعيدة

يُحل `/prose run <handle/slug>` إلى `https://p.prose.md/<handle>/<slug>`.
تُجلب عناوين URL المباشرة كما هي. يستخدم ذلك أداة `web_fetch` (أو `exec` لطلبات POST).

## تعيين وقت تشغيل OpenClaw

تُعيَّن برامج OpenProse إلى بدائيات OpenClaw:

| مفهوم OpenProse        | أداة OpenClaw    |
| ---------------------- | ---------------- |
| إنشاء جلسة / أداة مهمة | `sessions_spawn` |
| قراءة/كتابة الملفات    | `read` / `write` |
| جلب الويب              | `web_fetch`      |

إذا كانت قائمة السماح للأدوات لديك تحظر هذه الأدوات، فستفشل برامج OpenProse. راجع [Skills config](/tools/skills-config).

## الأمان والموافقات

تعامل مع ملفات `.prose` كما لو كانت شيفرة. راجعها قبل التشغيل. استخدم قوائم السماح لأدوات OpenClaw وبوابات الموافقة للتحكم في الآثار الجانبية.

لسير عمل حتمية ومقيّدة بالموافقات، قارن مع [Lobster](/tools/lobster).
