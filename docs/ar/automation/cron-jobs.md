---
summary: "وظائف Cron + الإيقاظات لمجدول Gateway"
read_when:
  - جدولة مهام الخلفية أو الإيقاظات
  - ربط الأتمتة التي يجب أن تعمل مع نبضات القلب أو بجانبها
  - اتخاذ قرار بين نبضة القلب وCron للمهام المجدولة
title: "وظائف Cron"
---

# وظائف Cron (مجدول Gateway)

> **Cron أم نبضة القلب؟** انظر [Cron مقابل نبضة القلب](/automation/cron-vs-heartbeat) للحصول على إرشادات حول متى تستخدم كلًا منهما.

Cron هو المجدول المدمج في Gateway. يقوم بحفظ المهام، وإيقاظ الوكيل في
الوقت المناسب، ويمكنه اختياريًا إيصال المخرجات إلى محادثة.

إذا كنت تريد «تشغيل هذا كل صباح» أو «تنبيه الوكيل بعد 20 دقيقة»،
فإن cron هو الآلية المناسبة.

استكشاف الأخطاء وإصلاحها: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- يعمل Cron **داخل Gateway** (وليس داخل النموذج).
- تستمر المهام تحت `~/.openclaw/cron/` بحيث لا تفقد الجداول عند إعادة التشغيل.
- نمطان للتنفيذ:
  - **الجلسة الرئيسية**: إدراج حدث نظام، ثم التشغيل في نبضة القلب التالية.
  - **معزول**: تشغيل دور وكيل مخصص في `cron:<jobId>`، مع التسليم (إعلان افتراضيًا أو بدون).
- الإيقاظات من الدرجة الأولى: يمكن للمهمة طلب «الإيقاظ الآن» مقابل «نبضة القلب التالية».

## البدء السريع (عملي)

أنشئ تذكيرًا لمرة واحدة، تحقق من وجوده، وشغّله فورًا:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

جدولة مهمة معزولة متكررة مع التسليم:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## مكافئات استدعاء الأدوات (أداة cron في Gateway)

لأشكال JSON القياسية والأمثلة، راجع [مخطط JSON لاستدعاءات الأدوات](/automation/cron-jobs#json-schema-for-tool-calls).

## أين تُخزَّن وظائف cron

تُحفَظ وظائف cron على مضيف Gateway افتراضيًا في `~/.openclaw/cron/jobs.json`.
يقوم Gateway بتحميل الملف إلى الذاكرة وكتابته عند التغييرات، لذا فإن التعديلات اليدوية
آمنة فقط عندما يكون Gateway متوقفًا. فضّل `openclaw cron add/edit` أو واجهة استدعاء أدوات cron
لإجراء التغييرات.

## نظرة عامة مناسبة للمبتدئين

فكّر في مهمة cron على أنها: **متى** يتم التشغيل + **ماذا** يتم التنفيذ.

1. **اختر الجدول**
   - تذكير لمرة واحدة → `schedule.kind = "at"` (CLI: `--at`)
   - مهمة متكررة → `schedule.kind = "every"` أو `schedule.kind = "cron"`
   - إذا كان طابع ISO الزمني يفتقد منطقة زمنية، فسيُعامَل على أنه **UTC**.

2. **اختر مكان التنفيذ**
   - `sessionTarget: "main"` → التشغيل خلال نبضة القلب التالية مع السياق الرئيسي.
   - `sessionTarget: "isolated"` → تشغيل دور وكيل مخصص في `cron:<jobId>`.

3. **اختر الحمولة**
   - الجلسة الرئيسية → `payload.kind = "systemEvent"`
   - الجلسة المعزولة → `payload.kind = "agentTurn"`

اختياري: مهام المرة الواحدة (`schedule.kind = "at"`) تُحذف افتراضيًا بعد النجاح. عيّن
`deleteAfterRun: false` للاحتفاظ بها (سيتم تعطيلها بعد النجاح).

## المفاهيم

### المهام

مهمة cron هي سجل محفوظ يحتوي على:

- **جدول** (متى يجب أن تعمل)،
- **حمولة** (ما الذي يجب فعله)،
- **وضع تسليم** اختياري (إعلان أو بدون).
- **ارتباط وكيل** اختياري (`agentId`): تشغيل المهمة تحت وكيل محدد؛ وإذا كان
  مفقودًا أو غير معروف، يعود Gateway إلى الوكيل الافتراضي.

تُعرَّف المهام بواسطة `jobId` ثابت (تستخدمه واجهات CLI/Gateway).
في استدعاءات أدوات الوكيل، يُعد `jobId` هو القياسي؛ ويُقبل القديم `id` للتوافق.
تُحذف مهام المرة الواحدة تلقائيًا بعد النجاح افتراضيًا؛ اضبط `deleteAfterRun: false` للاحتفاظ بها.

### الجداول

يدعم Cron ثلاثة أنواع من الجداول:

- `at`: طابع زمني لمرة واحدة عبر `schedule.at` (ISO 8601).
- `every`: فاصل ثابت (بالمللي ثانية).
- `cron`: تعبير cron من 5 حقول مع منطقة زمنية IANA اختيارية.

تستخدم تعبيرات cron `croner`. إذا أُهملت المنطقة الزمنية، تُستخدم المنطقة الزمنية
المحلية لمضيف Gateway.

### التنفيذ الرئيسي مقابل المعزول

#### مهام الجلسة الرئيسية (أحداث النظام)

تُدرج المهام الرئيسية حدث نظام ويمكنها اختياريًا إيقاظ مشغّل نبضة القلب.
يجب أن تستخدم `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (افتراضي): يُطلق الحدث تشغيلًا فوريًا لنبضة القلب.
- `wakeMode: "next-heartbeat"`: ينتظر الحدث حتى نبضة القلب المجدولة التالية.

هذا هو الخيار الأنسب عندما تريد مطالبة نبضة القلب المعتادة + سياق الجلسة الرئيسية.
انظر [نبضة القلب](/gateway/heartbeat).

#### المهام المعزولة (جلسات cron مخصصة)

تُشغِّل المهام المعزولة دور وكيل مخصص في الجلسة `cron:<jobId>`.

السلوكيات الأساسية:

- تُسبق المطالبة بـ `[cron:<jobId> <job name>]` لأغراض التتبّع.
- يبدأ كل تشغيل **معرّف جلسة جديد** (من دون ترحيل محادثة سابقة).
- السلوك الافتراضي: إذا أُهمل `delivery`، تعلن المهام المعزولة ملخصًا (`delivery.mode = "announce"`).
- `delivery.mode` (خاص بالمعزول) يحدد ما يحدث:
  - `announce`: تسليم ملخص إلى القناة المستهدفة ونشر ملخص موجز في الجلسة الرئيسية.
  - `none`: داخلي فقط (لا تسليم ولا ملخص للجلسة الرئيسية).
- يتحكم `wakeMode` في توقيت نشر ملخص الجلسة الرئيسية:
  - `now`: نبضة قلب فورية.
  - `next-heartbeat`: ينتظر نبضة القلب المجدولة التالية.

استخدم المهام المعزولة للأعمال المزعجة أو المتكررة أو «الأعمال الخلفية» التي لا ينبغي
أن تُغرق سجل الدردشة الرئيسي.

### أشكال الحمولة (ما يجري)

يدعم نوعان من الحمولات:

- `systemEvent`: خاص بالجلسة الرئيسية، يمر عبر مطالبة نبضة القلب.
- `agentTurn`: خاص بالجلسة المعزولة، يشغّل دور وكيل مخصص.

حقول `agentTurn` الشائعة:

- `message`: نص المطالبة المطلوب.
- `model` / `thinking`: تجاوزات اختيارية (انظر أدناه).
- `timeoutSeconds`: تجاوز مهلة اختياري.

تهيئة التسليم (للمهام المعزولة فقط):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` أو قناة محددة.
- `delivery.to`: هدف خاص بالقناة (هاتف/دردشة/معرّف قناة).
- `delivery.bestEffort`: تجنّب فشل المهمة إذا فشل تسليم الإعلان.

يقمع تسليم الإعلان إرسال أدوات المراسلة أثناء التشغيل؛ استخدم `delivery.channel`/`delivery.to`
لاستهداف الدردشة بدلًا من ذلك. عندما يكون `delivery.mode = "none"`، لا يُنشر ملخص في الجلسة الرئيسية.

إذا أُهمل `delivery` للمهام المعزولة، فإن OpenClaw يضبطه افتراضيًا على `announce`.

#### تدفّق تسليم الإعلان

عندما يكون `delivery.mode = "announce"`، يقوم cron بالتسليم مباشرة عبر محوّلات القنوات الصادرة.
لا يتم تشغيل الوكيل الرئيسي لصياغة الرسالة أو تمريرها.

تفاصيل السلوك:

- المحتوى: يستخدم التسليم حمولات الإخراج للتشغيل المعزول (نص/وسائط) مع التقسيم
  والتنسيق الطبيعيين للقناة.
- استجابات نبضة القلب فقط (`HEARTBEAT_OK` دون محتوى حقيقي) لا يتم تسليمها.
- إذا كان التشغيل المعزول قد أرسل رسالة بالفعل إلى الهدف نفسه عبر أداة المراسلة،
  يتم تخطي التسليم لتجنّب التكرار.
- الأهداف المفقودة أو غير الصالحة تُفشل المهمة ما لم يكن `delivery.bestEffort = true`.
- يُنشر ملخص قصير في الجلسة الرئيسية فقط عندما يكون `delivery.mode = "announce"`.
- يحترم ملخص الجلسة الرئيسية `wakeMode`: يُطلق `now` نبضة قلب فورية
  بينما ينتظر `next-heartbeat` نبضة القلب المجدولة التالية.

### تجاوزات النموذج ومستوى التفكير

يمكن للمهام المعزولة (`agentTurn`) تجاوز النموذج ومستوى التفكير:

- `model`: سلسلة الموفّر/النموذج (مثل `anthropic/claude-sonnet-4-20250514`) أو اسم مستعار (مثل `opus`)
- `thinking`: مستوى التفكير (`off`، `minimal`، `low`، `medium`، `high`، `xhigh`; نماذج GPT-5.2 + Codex فقط)

ملاحظة: يمكنك أيضًا تعيين `model` لمهام الجلسة الرئيسية، لكنه يغيّر نموذج
الجلسة الرئيسية المشتركة. نوصي بتجاوزات النموذج للمهام المعزولة فقط لتجنّب
تحوّلات غير متوقعة في السياق.

أولوية الحل:

1. تجاوز حمولة المهمة (الأعلى)
2. الإعدادات الافتراضية الخاصة بالخطّاف (مثل `hooks.gmail.model`)
3. الإعداد الافتراضي لتهيئة الوكيل

### التسليم (القناة + الهدف)

يمكن للمهام المعزولة تسليم المخرجات إلى قناة عبر تهيئة `delivery` ذات المستوى الأعلى:

- `delivery.mode`: `announce` (تسليم ملخص) أو `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (إضافة) / `signal` / `imessage` / `last`.
- `delivery.to`: هدف مستلم خاص بالقناة.

تهيئة التسليم صالحة فقط للمهام المعزولة (`sessionTarget: "isolated"`).

إذا أُهمل `delivery.channel` أو `delivery.to`، يمكن لـ cron الرجوع إلى «المسار الأخير»
للجلسة الرئيسية (آخر مكان رد فيه الوكيل).

تذكيرات تنسيق الهدف:

- يجب أن تستخدم أهداف Slack/Discord/Mattermost (إضافة) بادئات صريحة (مثل `channel:<id>`، `user:<id>`) لتجنّب الالتباس.
- يجب أن تستخدم موضوعات Telegram صيغة `:topic:` (انظر أدناه).

#### أهداف تسليم Telegram (الموضوعات / سلاسل المنتدى)

يدعم Telegram موضوعات المنتدى عبر `message_thread_id`. لتسليم cron، يمكنك ترميز
الموضوع/السلسلة في الحقل `to`:

- `-1001234567890` (معرّف الدردشة فقط)
- `-1001234567890:topic:123` (المفضّل: وسم موضوع صريح)
- `-1001234567890:123` (اختصار: لاحقة رقمية)

تُقبل أيضًا الأهداف ذات البادئات مثل `telegram:...` / `telegram:group:...`:

- `telegram:group:-1001234567890:topic:123`

## مخطط JSON لاستدعاءات الأدوات

استخدم هذه الأشكال عند استدعاء أدوات `cron.*` في Gateway مباشرة (استدعاءات أدوات الوكيل أو RPC).
تقبل أعلام CLI مددًا بشرية مثل `20m`، لكن يجب أن تستخدم استدعاءات الأدوات
سلسلة ISO 8601 لـ `schedule.at` ومللي ثانية لـ `schedule.everyMs`.

### معاملات cron.add

مهمة لمرة واحدة، جلسة رئيسية (حدث نظام):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

مهمة متكررة، معزولة مع التسليم:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

ملاحظات:

- `schedule.kind`: `at` (`at`)، `every` (`everyMs`)، أو `cron` (`expr`، اختياري `tz`).
- يقبل `schedule.at` صيغة ISO 8601 (المنطقة الزمنية اختيارية؛ تُعامل كـ UTC عند الإهمال).
- `everyMs` بالمللي ثانية.
- يجب أن يكون `sessionTarget` إما `"main"` أو `"isolated"` ويجب أن يطابق `payload.kind`.
- الحقول الاختيارية: `agentId`، `description`، `enabled`، `deleteAfterRun` (افتراضيًا true لـ `at`)،
  `delivery`.
- افتراضي `wakeMode` هو `"now"` عند الإهمال.

### معاملات cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

ملاحظات:

- يُعد `jobId` هو القياسي؛ ويُقبل `id` للتوافق.
- استخدم `agentId: null` في التصحيح لمسح ارتباط وكيل.

### معاملات cron.run و cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## التخزين والسجل

- مخزن المهام: `~/.openclaw/cron/jobs.json` (JSON مُدار من Gateway).
- سجل التشغيل: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL، يُنقّى تلقائيًا).
- تجاوز مسار التخزين: `cron.store` في التهيئة.

## التهيئة

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

تعطيل cron بالكامل:

- `cron.enabled: false` (تهيئة)
- `OPENCLAW_SKIP_CRON=1` (متغير بيئة)

## البدء السريع عبر CLI

تذكير لمرة واحدة (ISO UTC، حذف تلقائي بعد النجاح):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

تذكير لمرة واحدة (جلسة رئيسية، إيقاظ فوري):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

مهمة معزولة متكررة (إعلان إلى WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

مهمة معزولة متكررة (تسليم إلى موضوع Telegram):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

مهمة معزولة مع تجاوز النموذج ومستوى التفكير:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

اختيار الوكيل (إعدادات متعددة الوكلاء):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

تشغيل يدوي (القسر هو الافتراضي، استخدم `--due` للتشغيل فقط عند الاستحقاق):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

تحرير مهمة موجودة (تصحيح الحقول):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

تشغيل التاريخ:

```bash
openclaw cron runs --id <jobId> --limit 50
```

حدث نظام فوري دون إنشاء مهمة:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## واجهة Gateway البرمجية

- `cron.list`، `cron.status`، `cron.add`، `cron.update`، `cron.remove`
- `cron.run` (قسر أو مستحق)، `cron.runs`
  للأحداث النظامية الفورية دون مهمة، استخدم [`openclaw system event`](/cli/system).

## استكشاف الأخطاء وإصلاحها

### «لا شيء يعمل»

- تحقّق من تمكين cron: `cron.enabled` و `OPENCLAW_SKIP_CRON`.
- تحقّق من أن Gateway يعمل باستمرار (cron يعمل داخل عملية Gateway).
- لجدولات `cron`: أكّد المنطقة الزمنية (`--tz`) مقابل منطقة زمنية المضيف.

### مهمة متكررة تستمر في التأخير بعد الإخفاقات

- يطبّق OpenClaw تراجع إعادة المحاولة الأسي للمهام المتكررة بعد أخطاء متتالية:
  30 ثانية، 1 دقيقة، 5 دقائق، 15 دقيقة، ثم 60 دقيقة بين المحاولات.
- يُعاد ضبط التراجع تلقائيًا بعد التشغيل الناجح التالي.
- مهام المرة الواحدة (`at`) تُعطَّل بعد تشغيل نهائي (`ok`، `error`، أو `skipped`) ولا تعيد المحاولة.

### Telegram يسلّم إلى المكان الخطأ

- لموضوعات المنتدى، استخدم `-100…:topic:<id>` ليكون صريحًا وغير ملتبس.
- إذا رأيت بادئات `telegram:...` في السجلات أو في أهداف «المسار الأخير» المخزّنة، فهذا طبيعي؛
  يقبل تسليم cron هذه الصيغ ويحلّل معرّفات الموضوعات بشكل صحيح.
