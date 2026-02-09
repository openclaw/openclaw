---
title: Lobster
summary: "بيئة تشغيل لسير عمل مُنَمَّط لـ OpenClaw مع بوابات موافقة قابلة للاستئناف."
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - تريد سير عمل حتميًا متعدد الخطوات مع موافقات صريحة
  - تحتاج إلى استئناف سير عمل دون إعادة تشغيل الخطوات السابقة
---

# Lobster

Lobster هو غلاف لسير العمل يتيح لـ OpenClaw تشغيل تسلسلات أدوات متعددة الخطوات كعملية واحدة حتمية مع نقاط تحقق موافقة صريحة.

## Hook

يمكن لمساعدك بناء الأدوات التي تُدير نفسها. اطلب سير عمل، وبعد 30 دقيقة ستحصل على CLI بالإضافة إلى خطوط أنابيب تعمل كاستدعاء واحد. Lobster هو القطعة المفقودة: خطوط أنابيب حتمية، موافقات صريحة، وحالة قابلة للاستئناف.

## Why

اليوم، تتطلب سير العمل المعقّدة العديد من استدعاءات الأدوات ذهابًا وإيابًا. كل استدعاء يكلّف رموزًا، ويتعيّن على نموذج اللغة الكبير تنسيق كل خطوة. ينقل Lobster هذا التنسيق إلى بيئة تشغيل مُنَمَّطة:

- **استدعاء واحد بدلًا من عدة**: يشغّل OpenClaw استدعاء أداة Lobster واحدًا ويحصل على نتيجة مُنظَّمة.
- **موافقات مدمجة**: التأثيرات الجانبية (إرسال بريد إلكتروني، نشر تعليق) تُوقِف سير العمل حتى تتم الموافقة عليها صراحةً.
- **قابل للاستئناف**: تُعيد سير العمل المتوقفة رمزًا؛ وافق واستأنف دون إعادة تشغيل كل شيء.

## Why a DSL instead of plain programs?

Lobster صغير عمدًا. الهدف ليس «لغة جديدة»، بل مواصفة خطوط أنابيب متوقّعة وصديقة للذكاء الاصطناعي مع موافقات ورموز استئناف من الدرجة الأولى.

- **الموافقة/الاستئناف مدمجان**: يمكن لبرنامج عادي مطالبة إنسان، لكنه لا يستطيع _الإيقاف والاستئناف_ برمز دائم دون ابتكار بيئة التشغيل بنفسك.
- **الحتمية + قابلية التدقيق**: خطوط الأنابيب بيانات، لذا يسهل تسجيلها، ومقارنتها، وإعادة تشغيلها، ومراجعتها.
- **سطح مُقيَّد للذكاء الاصطناعي**: نحو صغير + تمرير JSON يقلّل المسارات «الإبداعية» ويجعل التحقق واقعيًا.
- **سياسة السلامة مدمجة**: تُفرَض المهلات، وحدود المخرجات، وفحوص sandbox، وقوائم السماح بواسطة بيئة التشغيل، لا كل نص برمجي.
- **لا يزال قابلًا للبرمجة**: يمكن لكل خطوة استدعاء أي CLI أو نص برمجي. إذا أردت JS/TS، فأنشئ ملفات `.lobster` من الشيفرة.

## How it works

يشغّل OpenClaw واجهة `lobster` CLI المحلية في **وضع الأداة** ويحلّل غلاف JSON من stdout.
إذا توقّف خط الأنابيب للموافقة، تُعيد الأداة `resumeToken` لتتمكّن من المتابعة لاحقًا.

## Pattern: small CLI + JSON pipes + approvals

ابنِ أوامر صغيرة تتحدث JSON، ثم اربطها في استدعاء Lobster واحد. (أسماء الأوامر أدناه أمثلة — استبدلها بأوامرك.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

إذا طلب خط الأنابيب موافقة، فاستأنف باستخدام الرمز:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

يُطلِق الذكاء الاصطناعي سير العمل؛ وينفّذ Lobster الخطوات. تُبقي بوابات الموافقة التأثيرات الجانبية صريحة وقابلة للتدقيق.

مثال: تحويل عناصر الإدخال إلى استدعاءات أدوات:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

لسير العمل التي تحتاج **خطوة LLM مُنظَّمة**، فعِّل الأداة الإضافية الاختيارية
`llm-task` واستدعِها من Lobster. يحافظ ذلك على حتمية سير العمل مع السماح بالتصنيف/التلخيص/الصياغة باستخدام نموذج.

فعِّل الأداة:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

استخدمها في خط أنابيب:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

انظر [LLM Task](/tools/llm-task) للتفاصيل وخيارات التهيئة.

## Workflow files (.lobster)

يمكن لـ Lobster تشغيل ملفات سير عمل YAML/JSON مع الحقول `name` و`args` و`steps` و`env` و`condition` و`approval`. في استدعاءات أداة OpenClaw، اضبط `pipeline` على مسار الملف.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

ملاحظات:

- تمرّر `stdin: $step.stdout` و`stdin: $step.json` مخرجات خطوة سابقة.
- يمكن لـ `condition` (أو `when`) تقييد الخطوات بناءً على `$step.approved`.

## Install Lobster

ثبّت واجهة Lobster CLI على **المضيف نفسه** الذي يشغّل OpenClaw Gateway (انظر [مستودع Lobster](https://github.com/openclaw/lobster))، وتأكد من أن `lobster` موجود على `PATH`.
إذا أردت استخدام موقع ثنائي مخصّص، فمرِّر `lobsterPath` **مطلقًا** في استدعاء الأداة.

## Enable the tool

Lobster أداة إضافة **اختيارية** (غير مفعّلة افتراضيًا).

موصى به (إضافي وآمن):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

أو لكل وكيل:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

تجنّب استخدام `tools.allow: ["lobster"]` ما لم تكن تنوي التشغيل في وضع قائمة السماح المقيِّد.

ملاحظة: قوائم السماح اختيارية لأدوات الإضافات. إذا كانت قائمة السماح لديك تُسمّي
أدوات الإضافات فقط (مثل `lobster`)، فسيُبقي OpenClaw الأدوات الأساسية مفعّلة. لتقييد الأدوات الأساسية،
ضمّن الأدوات أو المجموعات الأساسية التي تريدها في قائمة السماح أيضًا.

## Example: Email triage

من دون Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

مع Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

يُعيد غلاف JSON (مقتطع):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

يوافق المستخدم → استئناف:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

سير عمل واحد. حتمي. آمن.

## Tool parameters

### `run`

تشغيل خط أنابيب في وضع الأداة.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

تشغيل ملف سير عمل مع وسيطات:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

متابعة سير عمل متوقف بعد الموافقة.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: مسار مطلق لثنائي Lobster (تجاهله لاستخدام `PATH`).
- `cwd`: دليل العمل لخط الأنابيب (الافتراضي: دليل العمل للعملية الحالية).
- `timeoutMs`: إنهاء العملية الفرعية إذا تجاوزت هذه المدة (الافتراضي: 20000).
- `maxStdoutBytes`: إنهاء العملية الفرعية إذا تجاوز stdout هذا الحجم (الافتراضي: 512000).
- `argsJson`: سلسلة JSON تُمرَّر إلى `lobster run --args-json` (ملفات سير العمل فقط).

## Output envelope

يُعيد Lobster غلاف JSON بإحدى الحالات الثلاث:

- `ok` → اكتمل بنجاح
- `needs_approval` → متوقف؛ مطلوب `requiresApproval.resumeToken` للاستئناف
- `cancelled` → مرفوض أو مُلغى صراحةً

تُظهر الأداة الغلاف في كلٍّ من `content` (JSON منسّق) و`details` (كائن خام).

## Approvals

إذا كان `requiresApproval` موجودًا، افحص المطالبة وقرّر:

- `approve: true` → الاستئناف ومتابعة التأثيرات الجانبية
- `approve: false` → الإلغاء وإنهاء سير العمل

استخدم `approve --preview-from-stdin --limit N` لإرفاق معاينة JSON بطلبات الموافقة دون لواصق jq/heredoc مخصّصة. أصبحت رموز الاستئناف الآن مدمجة: يخزّن Lobster حالة استئناف سير العمل ضمن دليل الحالة الخاص به ويعيد مفتاح رمز صغيرًا.

## OpenProse

يتكامل OpenProse جيدًا مع Lobster: استخدم `/prose` لتنسيق التحضير متعدد الوكلاء، ثم شغّل خط أنابيب Lobster لموافقات حتمية. إذا احتاج برنامج Prose إلى Lobster، فاسمح بأداة `lobster` للوكلاء الفرعيين عبر `tools.subagents.tools`. انظر [OpenProse](/prose).

## Safety

- **عمليات فرعية محلية فقط** — لا توجد استدعاءات شبكة من الأداة الإضافية نفسها.
- **لا أسرار** — لا يدير Lobster OAuth؛ بل يستدعي أدوات OpenClaw التي تفعل ذلك.
- **مدرك لـ sandbox** — مُعطّل عندما يكون سياق الأداة داخل sandbox.
- **مُحصَّن** — يجب أن يكون `lobsterPath` مطلقًا إذا تم تحديده؛ وتُفرض المهلات وحدود المخرجات.

## Troubleshooting

- **`lobster subprocess timed out`** → زِد `timeoutMs`، أو قسّم خط أنابيب طويل.
- **`lobster output exceeded maxStdoutBytes`** → ارفع `maxStdoutBytes` أو قلّل حجم المخرجات.
- **`lobster returned invalid JSON`** → تأكد من تشغيل خط الأنابيب في وضع الأداة وأنه يطبع JSON فقط.
- **`lobster failed (code …)`** → شغّل خط الأنابيب نفسه في طرفية لفحص stderr.

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

مثال عام واحد: CLI لـ «الدماغ الثاني» + خطوط أنابيب Lobster تُدير ثلاثة مخازن Markdown (شخصي، شريك، مشترك). يُخرج CLI JSON للإحصاءات، وقوائم البريد الوارد، وعمليات فحص التقادم؛ ويقوم Lobster بربط تلك الأوامر في سير عمل مثل `weekly-review` و`inbox-triage` و`memory-consolidation` و`shared-task-sync`، وكلٌّ منها مع بوابات موافقة. يتولى الذكاء الاصطناعي الحكم (التصنيف) عند توفره، ويعود إلى قواعد حتمية عند عدم توفره.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
