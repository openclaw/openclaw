---
summary: "رسائل استطلاع نبضات القلب وقواعد الإشعارات"
read_when:
  - ضبط وتيرة نبضات القلب أو أسلوب المراسلة
  - اتخاذ القرار بين نبضات القلب وCron للمهام المجدولة
title: "نبضات القلب"
---

# نبضات القلب (Gateway)

> **نبضات القلب أم Cron؟** راجع [Cron vs Heartbeat](/automation/cron-vs-heartbeat) للإرشاد حول متى تستخدم كلًّا منهما.

تشغّل نبضات القلب **دورات وكيل دورية** في الجلسة الرئيسية بحيث يمكن للنموذج
إبراز أي أمر يحتاج إلى انتباه دون إغراقك بالرسائل.

استكشاف الأخطاء وإصلاحها: [/automation/troubleshooting](/automation/troubleshooting)

## البدء السريع (للمبتدئين)

1. اترك نبضات القلب مُمكّنة (الافتراضي هو `30m`، أو `1h` لمصادقة Anthropic OAuth/setup-token) أو اضبط وتيرتك الخاصة.
2. أنشئ قائمة تحقق صغيرة `HEARTBEAT.md` في مساحة عمل الوكيل (اختياري لكنها مُستحسنة).
3. قرر أين يجب أن تذهب رسائل نبضات القلب (`target: "last"` هو الافتراضي).
4. اختياري: فعّل تسليم الاستدلال الخاص بنبضات القلب لزيادة الشفافية.
5. اختياري: قيّد نبضات القلب بساعات النشاط (التوقيت المحلي).

مثال على التهيئة:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## الإعدادات الافتراضية

- الفاصل الزمني: `30m` (أو `1h` عندما تكون مصادقة Anthropic OAuth/setup-token هي الوضع المكتشف). عيّن `agents.defaults.heartbeat.every` أو `agents.list[].heartbeat.every` لكل وكيل؛ استخدم `0m` للتعطيل.
- نصّ الموجّه (قابل للتهيئة عبر `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- يُرسَل موجّه نبضات القلب **كما هو حرفيًا** كرسالة المستخدم. يتضمن موجّه النظام قسم «Heartbeat» وتُعلَّم العملية داخليًا.
- يتم التحقق من ساعات النشاط (`heartbeat.activeHours`) ضمن المنطقة الزمنية المُهيّأة.
  خارج النافذة، تُتخطّى نبضات القلب حتى العلامة التالية داخل النافذة.

## ما الغرض من موجّه نبضات القلب

الموجّه الافتراضي عام عن قصد:

- **المهام الخلفية**: عبارة «Consider outstanding tasks» تحفّز الوكيل على مراجعة المتابعات
  (البريد الوارد، التقويم، التذكيرات، الأعمال المُصطفّة) وإبراز أي أمر عاجل.
- **تفقّد بشري**: عبارة «Checkup sometimes on your human during day time» تحفّز
  رسالة خفيفة عرضية من نوع «هل تحتاج إلى شيء؟»، مع تجنّب الإزعاج الليلي باستخدام
  منطقتك الزمنية المحلية المُهيّأة (راجع [/concepts/timezone](/concepts/timezone)).

إذا أردت أن تؤدي نبضة القلب مهمة محددة جدًا (مثل «check Gmail PubSub
stats» أو «verify gateway health»)، فاضبط `agents.defaults.heartbeat.prompt` (أو
`agents.list[].heartbeat.prompt`) إلى نص مخصص (يُرسَل كما هو).

## عقد الاستجابة

- إذا لم يكن هناك ما يستدعي الانتباه، أجب بـ **`HEARTBEAT_OK`**.
- أثناء تشغيل نبضات القلب، يتعامل OpenClaw مع `HEARTBEAT_OK` على أنه إقرار عند ظهوره
  في **بداية أو نهاية** الرد. يُزال الرمز ويُسقَط الرد إذا كان المحتوى المتبقي
  **≤ `ackMaxChars`** (الافتراضي: 300).
- إذا ظهر `HEARTBEAT_OK` في **منتصف** الرد، فلا يُعامَل معاملة خاصة.
- للتنبيهات، **لا** تُدرج `HEARTBEAT_OK`؛ أعد نص التنبيه فقط.

خارج نبضات القلب، تُزال وتُسجَّل حالات `HEARTBEAT_OK` الشاردة في بداية/نهاية الرسالة؛
والرسالة التي تكون فقط `HEARTBEAT_OK` تُسقَط.

## التهيئة

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### النطاق والأولوية

- يحدد `agents.defaults.heartbeat` سلوك نبضات القلب العام.
- يندمج `agents.list[].heartbeat` فوقه؛ إذا كان لأي وكيل كتلة `heartbeat`، فإن **هؤلاء الوكلاء فقط** هم من يشغّلون نبضات القلب.
- يحدد `channels.defaults.heartbeat` افتراضيات الرؤية لجميع القنوات.
- يتجاوز `channels.<channel>.heartbeat` افتراضيات القنوات.
- يتجاوز `channels.<channel>.accounts.<id>.heartbeat` (قنوات متعددة الحسابات) إعدادات القناة لكل حساب.

### نبضات القلب لكل وكيل

إذا تضمّن أي إدخال `agents.list[]` كتلة `heartbeat`، فإن **هؤلاء الوكلاء فقط**
يشغّلون نبضات القلب. تندمج كتلة كل وكيل فوق `agents.defaults.heartbeat`
(حتى تتمكن من تعيين افتراضيات مشتركة مرة واحدة ثم تجاوزها لكل وكيل).

مثال: وكيلاَن، الوكيل الثاني فقط يشغّل نبضات القلب.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### مثال ساعات النشاط

قيّد نبضات القلب بساعات العمل في منطقة زمنية محددة:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

خارج هذه النافذة (قبل 9 صباحًا أو بعد 10 مساءً بتوقيت الساحل الشرقي)، تُتخطّى نبضات القلب. ستعمل العلامة المجدولة التالية داخل النافذة بشكل طبيعي.

### مثال متعدد الحسابات

استخدم `accountId` لاستهداف حساب محدد على قنوات متعددة الحسابات مثل Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### ملاحظات الحقول

- `every`: فاصل نبضات القلب (سلسلة مدة؛ وحدة افتراضية = دقائق).
- `model`: تجاوز اختياري للنموذج لتشغيلات نبضات القلب (`provider/model`).
- `includeReasoning`: عند التمكين، يسلّم أيضًا رسالة `Reasoning:` المنفصلة عند توفرها (بنفس شكل `/reasoning on`).
- `session`: مفتاح جلسة اختياري لتشغيلات نبضات القلب.
  - `main` (الافتراضي): الجلسة الرئيسية للوكيل.
  - مفتاح جلسة صريح (انسخه من `openclaw sessions --json` أو من [sessions CLI](/cli/sessions)).
  - تنسيقات مفاتيح الجلسات: راجع [Sessions](/concepts/session) و[Groups](/channels/groups).
- `target`:
  - `last` (الافتراضي): التسليم إلى آخر قناة خارجية مستخدمة.
  - قناة صريحة: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: تشغيل نبضة القلب لكن **من دون تسليم** خارجي.
- `to`: تجاوز اختياري للمستلم (معرّف خاص بالقناة، مثل E.164 لـ WhatsApp أو معرّف دردشة Telegram).
- `accountId`: معرّف حساب اختياري للقنوات متعددة الحسابات. عندما يكون `target: "last"`، ينطبق معرّف الحساب على آخر قناة مُحلَّلة إذا كانت تدعم الحسابات؛ وإلا فيُتجاهل. إذا لم يطابق معرّف الحساب حسابًا مُهيّأً للقناة المُحلَّلة، يُتخطّى التسليم.
- `prompt`: يتجاوز نص الموجّه الافتراضي (غير مدمج).
- `ackMaxChars`: الحد الأقصى لعدد الأحرف المسموح بها بعد `HEARTBEAT_OK` قبل التسليم.
- `activeHours`: يقيّد تشغيلات نبضات القلب بنافذة زمنية. كائن يحتوي على `start` (HH:MM، شامل)، و`end` (HH:MM حصري؛ يُسمح بـ `24:00` لنهاية اليوم)، و`timezone` اختياري.
  - في حال الإغفال أو `"user"`: يستخدم `agents.defaults.userTimezone` لديك إن كان مضبوطًا، وإلا يعود إلى المنطقة الزمنية لنظام المضيف.
  - `"local"`: يستخدم دائمًا المنطقة الزمنية لنظام المضيف.
  - أي معرّف IANA (مثل `America/New_York`): يُستخدم مباشرة؛ وإن كان غير صالح يعود إلى سلوك `"user"` أعلاه.
  - خارج نافذة النشاط، تُتخطّى نبضات القلب حتى العلامة التالية داخل النافذة.

## سلوك التسليم

- تعمل نبضات القلب في الجلسة الرئيسية للوكيل افتراضيًا (`agent:<id>:<mainKey>`)،
  أو `global` عندما يكون `session.scope = "global"`. عيّن `session` للتجاوز إلى
  جلسة قناة محددة (Discord/WhatsApp/etc.).
- يؤثر `session` فقط على سياق التشغيل؛ يتحكم التسليم كلٌّ من `target` و`to`.
- للتسليم إلى قناة/مستلم محدد، عيّن `target` + `to`. مع
  `target: "last"`، يستخدم التسليم آخر قناة خارجية لتلك الجلسة.
- إذا كان الطابور الرئيسي مشغولًا، تُتخطّى نبضة القلب وتُعاد المحاولة لاحقًا.
- إذا حُلِّل `target` إلى وجهة خارجية غير موجودة، فسيحدث التشغيل لكن لن تُرسل رسالة صادرة.
- ردود «نبضات القلب فقط» **لا** تُبقي الجلسة حيّة؛ يُستعاد آخر `updatedAt`
  بحيث ينتهي الخمول بشكل طبيعي.

## ضوابط الرؤية

افتراضيًا، تُخفى إقرارات `HEARTBEAT_OK` بينما يُسلَّم محتوى التنبيه. يمكنك ضبط ذلك لكل قناة أو لكل حساب:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

الأولوية: لكل حساب → لكل قناة → افتراضيات القناة → الافتراضيات المضمّنة.

### ما الذي يفعله كل علم

- `showOk`: يرسل إقرار `HEARTBEAT_OK` عندما يعيد النموذج ردًا من نوع OK فقط.
- `showAlerts`: يرسل محتوى التنبيه عندما يعيد النموذج ردًا غير OK.
- `useIndicator`: يُصدر أحداث مؤشرات لواجهات حالة المستخدم.

إذا كانت **الثلاثة جميعًا** False، يتخطّى OpenClaw تشغيل نبضة القلب بالكامل (لا استدعاء للنموذج).

### أمثلة لكل قناة مقابل لكل حساب

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### أنماط شائعة

| الهدف                                                               | التهيئة                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| السلوك الافتراضي (إقرارات صامتة، تنبيهات مفعّلة) | _(لا حاجة لتهيئة)_                                                    |
| صامت تمامًا (لا رسائل، لا مؤشّر)                 | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| مؤشّر فقط (لا رسائل)                             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| إقرارات OK في قناة واحدة فقط                                        | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (اختياري)

إذا وُجد ملف `HEARTBEAT.md` في مساحة العمل، يخبر الموجّه الافتراضي
الوكيل بقراءته. فكّر فيه على أنه «قائمة تحقق نبضات القلب» الخاصة بك:
صغيرة، ثابتة، وآمنة للإدراج كل 30 دقيقة.

إذا كان `HEARTBEAT.md` موجودًا لكنه فارغ فعليًا (أسطر فارغة فقط وعناوين Markdown مثل `# Heading`)، يتخطّى OpenClaw تشغيل نبضة القلب لتوفير استدعاءات واجهة برمجة التطبيقات.
إذا كان الملف مفقودًا، ستظل نبضة القلب تعمل ويقرر النموذج ما الذي يفعله.

أبقِه صغيرًا (قائمة قصيرة أو تذكيرات) لتجنّب تضخّم الموجّه.

مثال `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### هل يمكن للوكيل تحديث HEARTBEAT.md؟

نعم — إذا طلبت منه ذلك.

`HEARTBEAT.md` هو مجرد ملف عادي في مساحة عمل الوكيل، لذا يمكنك أن تقول للوكيل
(في محادثة عادية) شيئًا مثل:

- «حدّث `HEARTBEAT.md` لإضافة فحص يومي للتقويم».
- «أعد كتابة `HEARTBEAT.md` ليكون أقصر ومركّزًا على متابعات البريد الوارد».

إذا أردت أن يحدث ذلك بشكل استباقي، يمكنك أيضًا تضمين سطر صريح في موجّه نبضات القلب مثل:
«إذا أصبحت قائمة التحقق قديمة، حدّث HEARTBEAT.md بقائمة أفضل».

ملاحظة أمان: لا تضع أسرارًا (مفاتيح API، أرقام هواتف، رموز خاصة) في
`HEARTBEAT.md` — إذ يصبح جزءًا من سياق الموجّه.

## إيقاظ يدوي (عند الطلب)

يمكنك إدراج حدث نظامي وتشغيل نبضة قلب فورية عبر:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

إذا كان لدى عدة وكلاء `heartbeat` مُهيّأ، فإن الإيقاظ اليدوي يشغّل
نبضات قلب هؤلاء الوكلاء فورًا.

استخدم `--mode next-heartbeat` للانتظار حتى العلامة المجدولة التالية.

## تسليم الاستدلال (اختياري)

افتراضيًا، تسلّم نبضات القلب فقط حمولة «الإجابة» النهائية.

إذا أردت الشفافية، فعّل:

- `agents.defaults.heartbeat.includeReasoning: true`

عند التمكين، ستسلّم نبضات القلب أيضًا رسالة منفصلة مسبوقة بـ
`Reasoning:` (بنفس شكل `/reasoning on`). قد يكون هذا مفيدًا عندما
يدير الوكيل جلسات/مدونات متعددة وتريد معرفة سبب قراره بتنبيهك —
لكن قد يسرّب أيضًا تفاصيل داخلية أكثر مما ترغب. يُفضَّل إبقاؤه
مُعطّلًا في الدردشات الجماعية.

## الوعي بالتكلفة

تشغّل نبضات القلب دورات وكيل كاملة. الفواصل الأقصر تستهلك رموزًا أكثر. أبقِ `HEARTBEAT.md` صغيرًا وفكّر في `model` أو `target: "none"` الأرخص
إذا كنت تريد فقط تحديثات حالة داخلية.
