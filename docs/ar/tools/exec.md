---
summary: "استخدام أداة Exec، أوضاع stdin، ودعم TTY"
read_when:
  - عند استخدام أداة exec أو تعديلها
  - عند استكشاف سلوك stdin أو TTY وإصلاحه
title: "أداة Exec"
---

# أداة Exec

تشغيل أوامر الصدفة في مساحة العمل. تدعم التنفيذ في المقدّمة + الخلفية عبر `process`.
إذا كان `process` غير مسموح، فإن `exec` يعمل بشكل متزامن ويتجاهل `yieldMs`/`background`.
جلسات الخلفية تكون محصورة لكل وكيل؛ حيث إن `process` لا يرى إلا الجلسات التابعة لنفس الوكيل.

## المعلمات

- `command` (مطلوب)
- `workdir` (الافتراضي cwd)
- `env` (تجاوزات مفتاح/قيمة)
- `yieldMs` (الافتراضي 10000): التحويل التلقائي إلى الخلفية بعد مهلة
- `background` (قيمة منطقية): التشغيل في الخلفية فورًا
- `timeout` (بالثواني، الافتراضي 1800): الإنهاء عند الانقضاء
- `pty` (قيمة منطقية): التشغيل داخل طرفية زائفة عند توفرها (واجهات CLI المعتمدة على TTY فقط، وكلاء البرمجة، واجهات الطرفية)
- `host` (`sandbox | gateway | node`): مكان التنفيذ
- `security` (`deny | allowlist | full`): وضع الإنفاذ لـ `gateway`/`node`
- `ask` (`off | on-miss | always`): مطالبات الموافقة لـ `gateway`/`node`
- `node` (سلسلة): معرّف/اسم العُقدة لـ `host=node`
- `elevated` (قيمة منطقية): طلب وضع مرتفع (مضيف Gateway)؛ ولا يُفرض `security=full` إلا عندما يُحلّ الوضع المرتفع إلى `full`

ملاحظات:

- `host` افتراضيًا هو `sandbox`.
- يتم تجاهل `elevated` عندما يكون sandboxing معطّلًا (إذ يعمل exec بالفعل على المضيف).
- يتم التحكم في موافقات `gateway`/`node` بواسطة `~/.openclaw/exec-approvals.json`.
- يتطلب `node` عُقدة مقترنة (تطبيق مُرافِق أو مضيف عُقدة بلا واجهة).
- إذا كانت هناك عدة عُقد متاحة، فاضبط `exec.node` أو `tools.exec.node` لاختيار واحدة.
- على المضيفين غير العاملين بنظام Windows، يستخدم exec القيمة `SHELL` عند تعيينها؛ وإذا كان `SHELL` هو `fish`، فإنه يفضّل `bash` (أو `sh`)
  من `PATH` لتجنّب سكربتات غير المتوافقة مع fish، ثم يعود إلى `SHELL` إذا لم يوجد أيٌّ منهما.
- تنفيذ المضيف (`gateway`/`node`) يرفض `env.PATH` وتجاوزات المُحمِّل (`LD_*`/`DYLD_*`) من أجل
  منع اختطاف الثنائيات أو حقن الشيفرة.
- مهم: sandboxing **معطّل افتراضيًا**. إذا كان sandboxing معطّلًا، فإن `host=sandbox` يعمل مباشرةً على
  مضيف Gateway (من دون حاوية) و**لا يتطلب موافقات**. لفرض الموافقات، شغّل باستخدام
  `host=gateway` واضبط موافقات exec (أو فعّل sandboxing).

## التهيئة

- `tools.exec.notifyOnExit` (الافتراضي: true): عند التفعيل، تقوم جلسات exec التي تعمل في الخلفية بإدراج حدث نظام وطلب نبضة قلب عند الخروج.
- `tools.exec.approvalRunningNoticeMs` (الافتراضي: 10000): إصدار إشعار «قيد التشغيل» واحد عندما يستمر exec الخاضع للموافقة أطول من هذه المدة (0 للتعطيل).
- `tools.exec.host` (الافتراضي: `sandbox`)
- `tools.exec.security` (الافتراضي: `deny` لـ sandbox، و `allowlist` لـ Gateway + العُقدة عند عدم التعيين)
- `tools.exec.ask` (الافتراضي: `on-miss`)
- `tools.exec.node` (الافتراضي: غير معيّن)
- `tools.exec.pathPrepend`: قائمة أدلة تُضاف في المقدّمة إلى `PATH` لتشغيل exec.
- `tools.exec.safeBins`: ثنائيات آمنة لمدخل stdin فقط يمكن تشغيلها دون إدخالات صريحة في قائمة السماح.

مثال:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### التعامل مع PATH

- `host=gateway`: يدمج `PATH` الخاص بصدفة تسجيل الدخول لديك في بيئة exec. تُرفض تجاوزات `env.PATH`
  عند تنفيذ المضيف. ويستمر تشغيل البرنامج الخدمي نفسه مع `PATH` الأدنى:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: يشغّل `sh -lc` (صدفة تسجيل الدخول) داخل الحاوية، لذا قد يعيد `/etc/profile` تعيين `PATH`.
  يضيف OpenClaw في المقدّمة `env.PATH` بعد استيراد ملفات التعريف عبر متغير بيئة داخلي (من دون تفسير للصدفة)؛
  وينطبق `tools.exec.pathPrepend` هنا أيضًا.
- `host=node`: تُرسل إلى العُقدة فقط تجاوزات البيئة غير المحظورة التي تمرّرها. تُرفض تجاوزات `env.PATH`
  عند تنفيذ المضيف. يقبل مضيفو العُقد بلا واجهة `PATH` فقط عندما تُضاف في المقدّمة إلى مسار PATH الخاص بمضيف العُقدة
  (من دون استبدال). تسقط عُقد macOS تجاوزات `PATH` بالكامل.

ربط العُقدة لكل وكيل (استخدم فهرس قائمة الوكيل في التهيئة):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

واجهة التحكم: تتضمن علامة تبويب «العُقد» لوحة صغيرة بعنوان «ربط عُقدة Exec» للإعدادات نفسها.

## تجاوزات الجلسة (`/exec`)

استخدم `/exec` لتعيين الإعدادات الافتراضية **لكل جلسة** لكل من `host` و `security` و `ask` و `node`.
أرسل `/exec` دون وسائط لعرض القيم الحالية.

مثال:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## نموذج التفويض

لا يتم احترام `/exec` إلا للمرسلين **المخوّلين** (قوائم سماح القنوات/الاقتران إضافةً إلى `commands.useAccessGroups`).
يقوم بتحديث **حالة الجلسة فقط** ولا يكتب التهيئة. لتعطيل exec بشكل صارم، ارفضه عبر سياسة الأدوات
(`tools.deny: ["exec"]` أو لكل وكيل). تظل موافقات المضيف سارية ما لم تعيّن صراحةً
`security=full` و `ask=off`.

## موافقات Exec (التطبيق المُرافِق / مضيف العُقدة)

يمكن للوكلاء المعزولين بـ sandbox أن يتطلبوا موافقة لكل طلب قبل أن يعمل `exec` على مضيف Gateway أو مضيف العُقدة.
انظر [موافقات Exec](/tools/exec-approvals) لمعرفة السياسة وقائمة السماح وتدفق واجهة المستخدم.

عندما تكون الموافقات مطلوبة، تعيد أداة exec فورًا
`status: "approval-pending"` ومعرّف موافقة. بمجرد الموافقة (أو الرفض / انتهاء المهلة)،
يبعث Gateway أحداث نظام (`Exec finished` / `Exec denied`). وإذا ظل الأمر
قيد التشغيل بعد `tools.exec.approvalRunningNoticeMs`، يُصدَر إشعار واحد `Exec running`.

## قائمة السماح + الثنائيات الآمنة

يطابق إنفاذ قائمة السماح **مسارات الثنائيات المُحلّة فقط** (من دون مطابقة أسماء مجردة). عندما يكون
`security=allowlist`، تُسمح أوامر الصدفة تلقائيًا فقط إذا كان كل مقطع من خط الأنابيب
مدرجًا في قائمة السماح أو ضمن ثنائي آمن. يُرفض التسلسل (`;` و `&&` و `||`) وإعادة التوجيه في
وضع قائمة السماح.

## أمثلة

الواجهة:

```json
{ "tool": "exec", "command": "ls -la" }
```

الخلفية + الاستطلاع:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

إرسال المفاتيح (على نمط tmux):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

إرسال (إرسال CR فقط):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

لصق (مُحاط افتراضيًا):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (تجريبي)

`apply_patch` هي أداة فرعية من `exec` لإجراء تعديلات منظّمة على عدة ملفات.
فعّلها صراحةً:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

ملاحظات:

- متاحة فقط لنماذج OpenAI/OpenAI Codex.
- تظل سياسة الأدوات سارية؛ إذ يسمح `allow: ["exec"]` ضمنيًا بـ `apply_patch`.
- تقع التهيئة تحت `tools.exec.applyPatch`.
