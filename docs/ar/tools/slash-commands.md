---
summary: "أوامر Slash : النص مقابل الأمر الأصلي، التكوين، والأوامر المدعومة"
read_when:
  - استخدام أو تهيئة أوامر الدردشة
  - تصحيح توجيه الأوامر أو الأذونات
title: "أوامر Slash"
---

# tools/slash-commands.md

تتم معالجة الأوامر بواسطة Gateway. يجب إرسال معظم الأوامر كرسالة **مستقلة** تبدأ بـ `/`.
يستخدم أمر دردشة bash الخاص بالمضيف فقط `! <cmd>` (مع `/bash <cmd>` كاسم بديل).

هناك نظامان مترابطان:

- **الأوامر**: رسائل `/...` مستقلة.
- **التوجيهات**: `/think`، `/verbose`، `/reasoning`، `/elevated`، `/exec`، `/model`، `/queue`.
  - تتم إزالة التوجيهات من الرسالة قبل أن يراها النموذج.
  - في رسائل الدردشة العادية (غير المقتصرة على التوجيهات)، تُعامَل كتلميحات «مضمّنة» ولا تُبقي إعدادات الجلسة.
  - في الرسائل التي تحتوي على توجيهات فقط (تتضمن الرسالة توجيهات دون غيرها)، تُحفَظ في الجلسة ويُردّ بإشعار تأكيد.
  - لا تُطبَّق التوجيهات إلا على **المرسلين المصرّح لهم** (قوائم السماح/الاقتران للقنوات إضافةً إلى `commands.useAccessGroups`).
    يرى المرسلون غير المصرّح لهم التوجيهات كنص عادي.

توجد أيضًا بعض **الاختصارات المضمّنة** (للرسل المصرّح لهم/ضمن قوائم السماح فقط): `/help`، `/commands`، `/status`، `/whoami` (`/id`).
تُنفَّذ فورًا، وتُزال قبل أن يرى النموذج الرسالة، ويستمر النص المتبقي عبر التدفق المعتاد.

## التهيئة

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (الافتراضي `true`) يفعّل تحليل `/...` في رسائل الدردشة.
  - على الواجهات التي لا تدعم أوامر أصلية (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)، تظل الأوامر النصية تعمل حتى إذا عيّنت هذا إلى `false`.
- `commands.native` (الافتراضي `"auto"`) يسجّل الأوامر الأصلية.
  - تلقائي: مفعّل لـ Discord/Telegram؛ معطّل لـ Slack (حتى تضيف أوامر الشرطة المائلة)؛ ويتم تجاهله لدى الموفّرين دون دعم أصلي.
  - اضبط `channels.discord.commands.native` أو `channels.telegram.commands.native` أو `channels.slack.commands.native` للتجاوز لكل موفّر (قيمة منطقية أو `"auto"`).
  - `false` يمسح الأوامر المسجّلة سابقًا على Discord/Telegram عند بدء التشغيل. تُدار أوامر Slack داخل تطبيق Slack ولا تُزال تلقائيًا.
- `commands.nativeSkills` (الافتراضي `"auto"`) يسجّل أوامر **Skills** أصليةً عند الدعم.
  - تلقائي: مفعّل لـ Discord/Telegram؛ معطّل لـ Slack (يتطلب Slack إنشاء أمر شرطة مائلة لكل Skill).
  - اضبط `channels.discord.commands.nativeSkills` أو `channels.telegram.commands.nativeSkills` أو `channels.slack.commands.nativeSkills` للتجاوز لكل موفّر (قيمة منطقية أو `"auto"`).
- `commands.bash` (الافتراضي `false`) يفعّل `! <cmd>` لتشغيل أوامر صدفة المضيف (`/bash <cmd>` اسم بديل؛ يتطلب قوائم سماح `tools.elevated`).
- `commands.bashForegroundMs` (الافتراضي `2000`) يتحكم في مدة انتظار bash قبل التحويل إلى وضع الخلفية (`0` يُشغِّل في الخلفية فورًا).
- `commands.config` (الافتراضي `false`) يفعّل `/config` (قراءة/كتابة `openclaw.json`).
- `commands.debug` (الافتراضي `false`) يفعّل `/debug` (تجاوزات وقت التشغيل فقط).
- `commands.useAccessGroups` (الافتراضي `true`) يفرض قوائم السماح/السياسات على الأوامر.

## قائمة الأوامر

نصية + أصلية (عند التفعيل):

- `/help`
- `/commands`
- `/skill <name> [input]` (تشغيل Skill بالاسم)
- `/status` (عرض الحالة الحالية؛ يتضمن استخدام/حصة الموفّر لنموذج الموفّر الحالي عند التوفر)
- `/allowlist` (سرد/إضافة/إزالة إدخالات قوائم السماح)
- `/approve <id> allow-once|allow-always|deny` (حل مطالبات الموافقة على التنفيذ)
- `/context [list|detail|json]` (شرح «السياق»؛ يعرض `detail` حجم كل ملف + كل أداة + كل Skill + مطالبة النظام)
- `/whoami` (عرض معرّف المرسل؛ الاسم البديل: `/id`)
- `/subagents list|stop|log|info|send` (فحص/إيقاف/تسجيل/مراسلة تشغيلات الوكيل الفرعي للجلسة الحالية)
- `/config show|get|set|unset` (حفظ التهيئة على القرص، للمالك فقط؛ يتطلب `commands.config: true`)
- `/debug show|set|unset|reset` (تجاوزات وقت التشغيل، للمالك فقط؛ يتطلب `commands.debug: true`)
- `/usage off|tokens|full|cost` (تذييل استخدام لكل رد أو ملخص تكلفة محلي)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (التحكم في TTS؛ انظر [/tts](/tts))
  - Discord: الأمر الأصلي هو `/voice` (يحجز Discord `/tts`)؛ لا يزال النص `/tts` يعمل.
- `/stop`
- `/restart`
- `/dock-telegram` (الاسم البديل: `/dock_telegram`) (تحويل الردود إلى Telegram)
- `/dock-discord` (الاسم البديل: `/dock_discord`) (تحويل الردود إلى Discord)
- `/dock-slack` (الاسم البديل: `/dock_slack`) (تحويل الردود إلى Slack)
- `/activation mention|always` (للمجموعات فقط)
- `/send on|off|inherit` (للمالك فقط)
- `/reset` أو `/new [model]` (تلميح اختياري للنموذج؛ يُمرَّر الباقي كما هو)
- `/think <off|minimal|low|medium|high|xhigh>` (خيارات ديناميكية حسب النموذج/الموفّر؛ الأسماء البديلة: `/thinking`، `/t`)
- `/verbose on|full|off` (الاسم البديل: `/v`)
- `/reasoning on|off|stream` (الاسم البديل: `/reason`؛ عند التفعيل، يرسل رسالة منفصلة مسبوقة بـ `Reasoning:`؛ `stream` = مسودة Telegram فقط)
- `/elevated on|off|ask|full` (الاسم البديل: `/elev`؛ `full` يتجاوز موافقات التنفيذ)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (أرسل `/exec` لعرض الحالي)
- `/model <name>` (الاسم البديل: `/models`؛ أو `/<alias>` من `agents.defaults.models.*.alias`)
- `/queue <mode>` (إضافةً إلى خيارات مثل `debounce:2s cap:25 drop:summarize`؛ أرسل `/queue` لعرض الإعدادات الحالية)
- `/bash <command>` (خاص بالمضيف؛ اسم بديل لـ `! <command>`؛ يتطلب قوائم سماح `commands.bash: true` + `tools.elevated`)

نصية فقط:

- `/compact [instructions]` (انظر [/concepts/compaction](/concepts/compaction))
- `! <command>` (خاص بالمضيف؛ واحد في كل مرة؛ استخدم `!poll` + `!stop` للمهام طويلة الأمد)
- `!poll` (فحص المخرجات/الحالة؛ يقبل `sessionId` اختياريًا؛ يعمل `/bash poll` أيضًا)
- `!stop` (إيقاف مهمة bash الجارية؛ يقبل `sessionId` اختياريًا؛ يعمل `/bash stop` أيضًا)

ملاحظات:

- تقبل الأوامر `:` اختياريًا بين الأمر والمعاملات (مثل `/think: high`، `/send: on`، `/help:`).
- يقبل `/new <model>` اسمًا بديلًا للنموذج، أو `provider/model`، أو اسم موفّر (مطابقة تقريبية)؛ وإذا لم يوجد تطابق، يُعامَل النص كجسم الرسالة.
- للحصول على تفصيل كامل لاستخدام الموفّر، استخدم `openclaw status --usage`.
- يتطلب `/allowlist add|remove` `commands.config=true` ويحترم `configWrites` للقناة.
- يتحكم `/usage` في تذييل الاستخدام لكل رد؛ ويطبع `/usage cost` ملخص تكلفة محليًا من سجلات جلسة OpenClaw.
- `/restart` معطّل افتراضيًا؛ اضبط `commands.restart: true` لتفعيله.
- الغرض من `/verbose` هو التصحيح وزيادة الرؤية؛ أبقه **مُعطّلًا** في الاستخدام العادي.
- يُعد `/reasoning` (و`/verbose`) محفوفًا بالمخاطر في إعدادات المجموعات: فقد يكشفان عن تفكير داخلي أو مخرجات أدوات لم تقصد كشفها. يُفضَّل إبقاؤهما مُعطّلين، خصوصًا في دردشات المجموعات.
- **المسار السريع:** تُعالج الرسائل التي تحتوي على أوامر فقط من مرسلين ضمن قوائم السماح فورًا (تجاوز الطابور + النموذج).
- **بوابة الإشارة في المجموعات:** تتجاوز الرسائل التي تحتوي على أوامر فقط من مرسلين ضمن قوائم السماح متطلبات الإشارة.
- **الاختصارات المضمّنة (للرسل ضمن قوائم السماح فقط):** تعمل بعض الأوامر أيضًا عند تضمينها في رسالة عادية وتُزال قبل أن يرى النموذج النص المتبقي.
  - مثال: `hey /status` يُطلق رد حالة، ويستمر النص المتبقي عبر التدفق المعتاد.
- حاليًا: `/help`، `/commands`، `/status`، `/whoami` (`/id`).
- تُتجاهَل الرسائل غير المصرّح بها التي تحتوي على أوامر فقط بصمت، وتُعامَل رموز `/...` المضمّنة كنص عادي.
- **أوامر Skills:** تُعرَض Skills من `user-invocable` كأوامر شرطة مائلة. تُنقَّى الأسماء إلى `a-z0-9_` (حد أقصى 32 حرفًا)؛ وتحصل التصادمات على لواحق رقمية (مثل `_2`).
  - يُشغِّل `/skill <name> [input]` Skill بالاسم (مفيد عندما تمنع حدود الأوامر الأصلية إنشاء أوامر لكل Skill).
  - افتراضيًا، تُمرَّر أوامر Skills إلى النموذج كطلب عادي.
  - قد تُصرّح Skills اختياريًا بـ `command-dispatch: tool` لتوجيه الأمر مباشرةً إلى أداة (حتمي، بلا نموذج).
  - مثال: `/prose` (إضافة OpenProse) — انظر [OpenProse](/prose).
- **وسائط الأوامر الأصلية:** يستخدم Discord الإكمال التلقائي للخيارات الديناميكية (وقوائم الأزرار عندما تُهمل وسائط مطلوبة). يعرض Telegram وSlack قائمة أزرار عندما يدعم الأمر خيارات وتُهمل الوسيط.

## أسطح الاستخدام (ما الذي يظهر وأين)

- **استخدام/حصة الموفّر** (مثال: «Claude متبقّي 80%») يظهر في `/status` لموفّر النموذج الحالي عند تفعيل تتبّع الاستخدام.
- **الرموز/التكلفة لكل رد** يتحكم فيها `/usage off|tokens|full` (تُلحق بالردود العادية).
- `/model status` يتعلق بـ **النماذج/المصادقة/النقاط الطرفية**، وليس بالاستخدام.

## اختيار النموذج (`/model`)

تم تنفيذ `/model` كتوجيه.

أمثلة:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

ملاحظات:

- يعرض `/model` و`/model list` مُنتقيًا مدمجًا مُرقّمًا (عائلة النموذج + الموفّرات المتاحة).
- يختار `/model <#>` من ذلك المُنتقي (ويُفضّل الموفّر الحالي عندما يكون ممكنًا).
- يعرض `/model status` العرض التفصيلي، بما في ذلك نقطة نهاية الموفّر المُهيّأة (`baseUrl`) ووضع واجهة API (`api`) عند التوفر.

## Debug overrides

يتيح `/debug` تعيين تجاوزات تهيئة **وقت التشغيل فقط** (في الذاكرة، لا على القرص). للمالك فقط. معطّل افتراضيًا؛ فعِّله باستخدام `commands.debug: true`.

أمثلة:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

ملاحظات:

- تُطبَّق التجاوزات فورًا على قراءات التهيئة الجديدة، لكنها **لا** تكتب إلى `openclaw.json`.
- استخدم `/debug reset` لمسح جميع التجاوزات والعودة إلى تهيئة القرص.

## تحديثات التهيئة

يكتب `/config` إلى تهيئة القرص لديك (`openclaw.json`). للمالك فقط. معطّل افتراضيًا؛ فعِّله باستخدام `commands.config: true`.

أمثلة:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

ملاحظات:

- يتم التحقق من صحة التهيئة قبل الكتابة؛ تُرفَض التغييرات غير الصالحة.
- تستمر تحديثات `/config` عبر عمليات إعادة التشغيل.

## ملاحظات الأسطح

- **الأوامر النصية** تعمل ضمن جلسة الدردشة العادية (تشارك الرسائل الخاصة `main`، وللمجموعات جلساتها الخاصة).
- **الأوامر الأصلية** تستخدم جلسات معزولة:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (يمكن تهيئة البادئة عبر `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (تستهدف جلسة الدردشة عبر `CommandTargetSessionKey`)
- **`/stop`** يستهدف جلسة الدردشة النشطة حتى يتمكن من إيقاف التشغيل الحالي.
- **Slack:** لا يزال `channels.slack.slashCommand` مدعومًا لأمر واحد بنمط `/openclaw`. إذا فعّلت `commands.native`، يجب إنشاء أمر شرطة مائلة واحد في Slack لكل أمر مدمج (بالأسماء نفسها مثل `/help`). تُقدَّم قوائم وسائط الأوامر لـ Slack كأزرار Block Kit مؤقتة.
