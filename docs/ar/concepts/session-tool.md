---
summary: "أدوات جلسات الوكيل لعرض الجلسات، وجلب السجل، وإرسال الرسائل عبر الجلسات"
read_when:
  - إضافة أدوات الجلسات أو تعديلها
title: "أدوات الجلسات"
---

# أدوات الجلسات

الهدف: مجموعة أدوات صغيرة وصعبة الإساءة في الاستخدام تُمكّن الوكلاء من عرض الجلسات، وجلب السجل، والإرسال إلى جلسة أخرى.

## أسماء الأدوات

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## نموذج المفاتيح

- حاوية الدردشة المباشرة الرئيسية هي دائمًا المفتاح الحرفي `"main"` (يُحلّ إلى المفتاح الرئيسي للوكيل الحالي).
- تستخدم الدردشات الجماعية `agent:<agentId>:<channel>:group:<id>` أو `agent:<agentId>:<channel>:channel:<id>` (مرّر المفتاح الكامل).
- تستخدم مهام Cron المفتاح `cron:<job.id>`.
- تستخدم Hooks المفتاح `hook:<uuid>` ما لم يُعيَّن صراحةً.
- تستخدم جلسات العُقدة المفتاح `node-<nodeId>` ما لم يُعيَّن صراحةً.

القيمتان `global` و`unknown` محجوزتان ولا تُدرجان أبدًا. إذا كان `session.scope = "global"`، فنُسميه اسمًا مستعارًا إلى `main` لجميع الأدوات حتى لا يرى المستدعون `global`.

## sessions_list

قائمة الجلسات كمجموعة من الصفوف

المعلمات:

- مرشح `kinds?: string[]`: أي من `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` الحد الأقصى للصفوف (الافتراضي: افتراضي الخادم، مع التقليم مثلًا 200)
- `activeMinutes?: number` الجلسات المحدَّثة خلال N دقيقة فقط
- `messageLimit?: number` 0 = بلا رسائل (الافتراضي 0)؛ >0 = تضمين آخر N رسائل

السلوك:

- يجلب `messageLimit > 0` قيمة `chat.history` لكل جلسة ويُضمِّن آخر N رسائل.
- تُرشَّح نتائج الأدوات من مخرجات القائمة؛ استخدم `sessions_history` لرسائل الأدوات.
- عند التشغيل داخل جلسة وكيل **sandboxed**، تُضبط أدوات الجلسات افتراضيًا على **رؤية الجلسات المُنشأة فقط** (انظر أدناه).

شكل الصف (JSON):

- `key`: مفتاح الجلسة (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (تسمية عرض المجموعة إن توفرت)
- `updatedAt` (مللي ثانية)
- `sessionId`
- `model`، `contextTokens`، `totalTokens`
- `thinkingLevel`، `verboseLevel`، `systemSent`، `abortedLastRun`
- `sendPolicy` (تجاوز الجلسة إن كان مضبوطًا)
- `lastChannel`، `lastTo`
- `deliveryContext` (`{ channel, to, accountId }` مُوحَّد عند التوفر)
- `transcriptPath` (مسار بأفضل جهد مشتق من دليل التخزين + sessionId)
- `messages?` (فقط عندما `messageLimit > 0`)

## sessions_history

جلب النص الكامل (Transcript) لجلسة واحدة.

المعلمات:

- `sessionKey` (مطلوب؛ يقبل مفتاح الجلسة أو `sessionId` من `sessions_list`)
- `limit?: number` الحد الأقصى للرسائل (يُقَلَّم من الخادم)
- `includeTools?: boolean` (الافتراضي false)

السلوك:

- يُرشِّح `includeTools=false` رسائل `role: "toolResult"`.
- يُعيد مصفوفة الرسائل بصيغة النص الخام.
- عند تزويده بـ `sessionId`، يقوم OpenClaw بحلّه إلى مفتاح الجلسة المقابل (خطأ عند فقدان المعرّفات).

## sessions_send

إرسال رسالة إلى جلسة أخرى.

المعلمات:

- `sessionKey` (مطلوب؛ يقبل مفتاح الجلسة أو `sessionId` من `sessions_list`)
- `message` (مطلوب)
- `timeoutSeconds?: number` (الافتراضي >0؛ 0 = إرسال دون انتظار)

السلوك:

- `timeoutSeconds = 0`: إدراج في الطابور وإرجاع `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: الانتظار حتى N ثوانٍ للاكتمال، ثم إرجاع `{ runId, status: "ok", reply }`.
- إذا انتهت مهلة الانتظار: `{ runId, status: "timeout", error }`. يستمر التشغيل؛ استدعِ `sessions_history` لاحقًا.
- إذا فشل التشغيل: `{ runId, status: "error", error }`.
- تُعلَن عمليات التسليم بعد اكتمال التشغيل الأساسي وبأفضل جهد؛ `status: "ok"` لا يضمن تسليم الإعلان.
- يتم الانتظار عبر `agent.wait` في Gateway (من جهة الخادم) بحيث لا تؤدي إعادة الاتصال إلى إسقاط الانتظار.
- يُحقَن سياق رسالة وكيل-إلى-وكيل للتشغيل الأساسي.
- بعد اكتمال التشغيل الأساسي، يُجري OpenClaw **حلقة الردّ العكسي**:
  - تتناوب الجولة 2+ بين الوكيل الطالب والوكيل الهدف.
  - الردّ بالضبط `REPLY_SKIP` لإيقاف تبادل ping‑pong.
  - الحد الأقصى للأدوار هو `session.agentToAgent.maxPingPongTurns` (0–5، الافتراضي 5).
- عند انتهاء الحلقة، يُجري OpenClaw **خطوة الإعلان وكيل-إلى-وكيل** (الوكيل الهدف فقط):
  - الردّ بالضبط `ANNOUNCE_SKIP` للبقاء صامتًا.
  - أي ردّ آخر يُرسَل إلى القناة الهدف.
  - تتضمن خطوة الإعلان الطلب الأصلي + رد الجولة الأولى + أحدث ردّ ping‑pong.

## حقل القناة

- للمجموعات، `channel` هي القناة المسجَّلة في مُدخل الجلسة.
- للدردشات المباشرة، `channel` تُعيَّن من `lastChannel`.
- لـ cron/hook/node، تكون `channel` هي `internal`.
- إذا كانت مفقودة، فإن `channel` هي `unknown`.

## الأمان / سياسة الإرسال

الحظر القائم على السياسة حسب نوع القناة/الدردشة (وليس حسب معرّف الجلسة).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

التجاوز أثناء التشغيل (لكل مُدخل جلسة):

- `sendPolicy: "allow" | "deny"` (غير مضبوط = يرث التهيئة)
- قابل للضبط عبر `sessions.patch` أو `/send on|off|inherit` للمالك فقط (رسالة مستقلة).

نقاط الإنفاذ:

- `chat.send` / `agent` (Gateway)
- منطق تسليم الردّ التلقائي

## sessions_spawn

إنشاء تشغيل لوكيل فرعي في جلسة معزولة والإعلان عن النتيجة إلى قناة دردشة الطالب.

المعلمات:

- `task` (مطلوب)
- `label?` (اختياري؛ يُستخدم للسجلات/واجهة المستخدم)
- `agentId?` (اختياري؛ الإنشاء تحت معرّف وكيل آخر إذا كان مسموحًا)
- `model?` (اختياري؛ يتجاوز نموذج الوكيل الفرعي؛ القيم غير الصالحة تُحدث خطأ)
- `runTimeoutSeconds?` (الافتراضي 0؛ عند الضبط، يُجهِض تشغيل الوكيل الفرعي بعد N ثانية)
- `cleanup?` (`delete|keep`، الافتراضي `keep`)

قائمة السماح:

- `agents.list[].subagents.allowAgents`: قائمة معرّفات الوكلاء المسموح بها عبر `agentId` (`["*"]` للسماح لأيٍّ كان). الافتراضي: وكيل الطالب فقط.

الاكتشاف:

- استخدم `agents_list` لاكتشاف معرّفات الوكلاء المسموح بها لـ `sessions_spawn`.

السلوك:

- يبدأ جلسة `agent:<agentId>:subagent:<uuid>` جديدة مع `deliver: false`.
- الوكلاء الفرعيون افتراضيًا يمتلكون مجموعة الأدوات الكاملة **باستثناء أدوات الجلسات** (قابلة للتهيئة عبر `tools.subagents.tools`).
- لا يُسمح للوكلاء الفرعيين باستدعاء `sessions_spawn` (لا إنشاء وكيل فرعي → وكيل فرعي).
- دائمًا غير حاجب: يُعيد `{ status: "accepted", runId, childSessionKey }` فورًا.
- بعد الاكتمال، يُجري OpenClaw **خطوة إعلان** للوكيل الفرعي وينشر النتيجة إلى قناة دردشة الطالب.
- الردّ بالضبط `ANNOUNCE_SKIP` أثناء خطوة الإعلان للبقاء صامتًا.
- تُوحَّد ردود الإعلان إلى `Status`/`Result`/`Notes`؛ ويأتي `Status` من نتيجة وقت التشغيل (وليس نص النموذج).
- تُؤرشَف جلسات الوكيل الفرعي تلقائيًا بعد `agents.defaults.subagents.archiveAfterMinutes` (الافتراضي: 60).
- تتضمن ردود الإعلان سطر إحصاءات (المدة، الرموز، sessionKey/sessionId، مسار النص، وتكلفة اختيارية).

## رؤية جلسات Sandbox

يمكن للجلسات sandboxed استخدام أدوات الجلسات، ولكنها افتراضيًا ترى فقط الجلسات التي أنشأتها عبر `sessions_spawn`.

التهيئة:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
