---
summary: "واجهة أدوات الوكيل في OpenClaw (المتصفح، اللوحة، العُقد، الرسائل، cron) التي تستبدل مهارات `openclaw-*` القديمة"
read_when:
  - عند إضافة أدوات الوكيل أو تعديلها
  - عند إيقاف مهارات `openclaw-*` أو تغييرها
title: "الأدوات"
---

# الأدوات (OpenClaw)

يُوفّر OpenClaw **أدوات وكيل من الدرجة الأولى** للمتصفح واللوحة والعُقد وcron.
تحلّ هذه الأدوات محل مهارات `openclaw-*` القديمة: فهي مُنمذجة Typed، ولا تعتمد على تنفيذ الأوامر عبر الصدفة،
ويجب على الوكيل الاعتماد عليها مباشرةً.

## تعطيل الأدوات

يمكنك السماح/المنع للأدوات على مستوى عام عبر `tools.allow` / `tools.deny` في `openclaw.json`
(الأولوية للمنع). يمنع ذلك إرسال الأدوات غير المسموح بها إلى موفّري النماذج.

```json5
{
  tools: { deny: ["browser"] },
}
```

ملاحظات:

- المطابقة غير حسّاسة لحالة الأحرف.
- تدعم بدائل `*` (`"*"` تعني جميع الأدوات).
- إذا كانت `tools.allow` تشير فقط إلى أسماء أدوات إضافات غير معروفة أو غير مُحمّلة، يسجّل OpenClaw تحذيرًا ويتجاهل قائمة السماح بحيث تبقى الأدوات الأساسية متاحة.

## ملفات تعريف الأدوات (قائمة السماح الأساسية)

يضبط `tools.profile` **قائمة سماح أساسية للأدوات** قبل `tools.allow`/`tools.deny`.
تجاوز لكل وكيل: `agents.list[].tools.profile`.

الملفات التعريفية:

- `minimal`: `session_status` فقط
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: بلا قيود (مماثل لعدم الضبط)

مثال (الرسائل فقط افتراضيًا، والسماح بأدوات Slack وDiscord أيضًا):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

مثال (ملف تعريف البرمجة، لكن منع exec/process في كل مكان):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

مثال (ملف تعريف برمجة عام، ووكيل دعم رسائل فقط):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## سياسة أدوات خاصة بالموفّر

استخدم `tools.byProvider` **لتقييد الأدوات بشكلٍ إضافي** لموفّرين محددين
(أو `provider/model` واحد) دون تغيير الإعدادات الافتراضية العامة.
تجاوز لكل وكيل: `agents.list[].tools.byProvider`.

يُطبَّق هذا **بعد** ملف تعريف الأدوات الأساسي و**قبل** قوائم السماح/المنع،
لذا يمكنه فقط تضييق مجموعة الأدوات.
تقبل مفاتيح الموفّر إما `provider` (مثل `google-antigravity`) أو
`provider/model` (مثل `openai/gpt-5.2`).

مثال (الإبقاء على ملف تعريف البرمجة العام، لكن أدوات حدّية لـ Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

مثال (قائمة سماح خاصة بالموفّر/النموذج لنقطة نهاية غير مستقرة):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

مثال (تجاوز خاص بالوكيل لموفّر واحد):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## مجموعات الأدوات (اختصارات)

تدعم سياسات الأدوات (العامة، الوكيل، sandbox) إدخالات `group:*` التي تتوسّع إلى عدة أدوات.
استخدمها في `tools.allow` / `tools.deny`.

المجموعات المتاحة:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: جميع أدوات OpenClaw المضمّنة (يستثني إضافات الموفّرين)

مثال (السماح بأدوات الملفات + المتصفح فقط):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## الإضافات + الأدوات

يمكن للإضافات تسجيل **أدوات إضافية** (وأوامر CLI) تتجاوز المجموعة الأساسية.
انظر [Plugins](/tools/plugin) للتثبيت + التهيئة، و[Skills](/tools/skills) لكيفية
حقن إرشادات استخدام الأدوات في المطالبات. تشحن بعض الإضافات مهاراتها الخاصة
جنبًا إلى جنب مع الأدوات (على سبيل المثال، إضافة المكالمات الصوتية).

أدوات إضافات اختيارية:

- [Lobster](/tools/lobster): وقت تشغيل لسير العمل مُنمذج Typed مع موافقات قابلة للاستئناف (يتطلّب Lobster CLI على مضيف Gateway).
- [LLM Task](/tools/llm-task): خطوة LLM بمدخلات/مخرجات JSON فقط لإخراج منظّم لسير العمل (تحقق مخطط اختياري).

## جرد الأدوات

### `apply_patch`

تطبيق تصحيحات منظّمة عبر ملف واحد أو أكثر. يُستخدم لتحريرات متعددة المقاطع.
تجريبي: فعّل عبر `tools.exec.applyPatch.enabled` (نماذج OpenAI فقط).

### `exec`

تشغيل أوامر الصدفة في مساحة العمل.

المعلمات الأساسية:

- `command` (مطلوب)
- `yieldMs` (التحويل التلقائي إلى الخلفية بعد مهلة، الافتراضي 10000)
- `background` (خلفية فورية)
- `timeout` (بالثواني؛ يقتل العملية إذا تجاوزت، الافتراضي 1800)
- `elevated` (منطقي؛ التشغيل على المضيف إذا كان وضع الرفع مُمكّنًا/مسموحًا؛ لا يغيّر السلوك إلا عندما يكون الوكيل في sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (معرّف/اسم العُقدة لـ `host=node`)
- هل تحتاج TTY حقيقيًا؟ اضبط `pty: true`. تعيين `pty: true`.

ملاحظات:

- يعيد `status: "running"` مع `sessionId` عند التشغيل في الخلفية.
- استخدم `process` للاستطلاع/التسجيل/الكتابة/الإيقاف/المسح لجلسات الخلفية.
- إذا كان `process` غير مسموح، يعمل `exec` تزامنيًا ويتجاهل `yieldMs`/`background`.
- `elevated` مقيّد عبر `tools.elevated` بالإضافة إلى أي تجاوز `agents.list[].tools.elevated` (يجب أن يسمح الاثنان) وهو اسم مستعار لـ `host=gateway` + `security=full`.
- `elevated` لا يغيّر السلوك إلا عندما يكون الوكيل في sandbox (وإلا فلا تأثير).
- يمكن لـ `host=node` الاستهداف لتطبيق مرافق على macOS أو لمضيف عُقدة بلا واجهة (`openclaw node run`).
- موافقات Gateway/العُقد وقوائم السماح: [Exec approvals](/tools/exec-approvals).

### `process`

إدارة جلسات exec في الخلفية.

الإجراءات الأساسية:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

ملاحظات:

- يعيد `poll` ناتجًا جديدًا وحالة الخروج عند الاكتمال.
- يدعم `log` `offset`/`limit` على أساس الأسطر (احذف `offset` لالتقاط آخر N أسطر).
- `process` بنطاق كل وكيل؛ جلسات الوكلاء الآخرين غير مرئية.

### `web_search`

البحث على الويب باستخدام Brave Search API.

المعلمات الأساسية:

- `query` (مطلوب)
- `count` (1–10؛ الافتراضي من `tools.web.search.maxResults`)

ملاحظات:

- يتطلب مفتاح Brave API (مستحسن: `openclaw configure --section web`، أو اضبط `BRAVE_API_KEY`).
- فعّل عبر `tools.web.search.enabled`.
- يتم تخزين الردود مؤقتًا (الافتراضي 15 دقيقة).
- راجع [Web tools](/tools/web) للإعداد.

### `web_fetch`

جلب واستخراج محتوى مقروء من عنوان URL (HTML → markdown/text).

المعلمات الأساسية:

- `url` (مطلوب)
- `extractMode` (`markdown` | `text`)
- `maxChars` (اقتطاع الصفحات الطويلة)

ملاحظات:

- فعّل عبر `tools.web.fetch.enabled`.
- يتم تقييد `maxChars` بواسطة `tools.web.fetch.maxCharsCap` (الافتراضي 50000).
- يتم تخزين الردود مؤقتًا (الافتراضي 15 دقيقة).
- للمواقع الثقيلة بالـ JS، يُفضّل أداة المتصفح.
- راجع [Web tools](/tools/web) للإعداد.
- راجع [Firecrawl](/tools/firecrawl) كبديل اختياري لمكافحة الروبوتات.

### `browser`

التحكم في المتصفح المُدار من OpenClaw والمخصّص.

الإجراءات الأساسية:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (يعيد كتلة صورة + `MEDIA:<path>`)
- `act` (إجراءات واجهة المستخدم: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

إدارة الملفات التعريفية:

- `profiles` — سرد جميع ملفات تعريف المتصفح مع الحالة
- `create-profile` — إنشاء ملف تعريف جديد مع منفذ مُخصّص تلقائيًا (أو `cdpUrl`)
- `delete-profile` — إيقاف المتصفح، حذف بيانات المستخدم، الإزالة من التهيئة (محلي فقط)
- `reset-profile` — قتل عملية孤 orphan على منفذ الملف التعريفي (محلي فقط)

المعلمات الشائعة:

- `profile` (اختياري؛ الافتراضي `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (اختياري؛ اختيار معرّف/اسم عُقدة محدد)
  ملاحظات:
- يتطلب `browser.enabled=true` (الافتراضي `true`؛ اضبط `false` للتعطيل).
- تقبل جميع الإجراءات معلمة `profile` الاختيارية لدعم تعدد النسخ.
- عند حذف `profile`، يُستخدم `browser.defaultProfile` (الافتراضي "chrome").
- أسماء الملفات التعريفية: أحرف وأرقام صغيرة + شرطات فقط (حد أقصى 64 حرفًا).
- نطاق المنافذ: 18800-18899 (~100 ملف تعريف كحد أقصى).
- الملفات التعريفية البعيدة للاتصال فقط (لا بدء/إيقاف/إعادة ضبط).
- إذا كانت هناك عُقدة قادرة على المتصفح متصلة، قد تُوجّه الأداة تلقائيًا إليها (ما لم تثبّت `target`).
- `snapshot` افتراضيًا `ai` عند تثبيت Playwright؛ استخدم `aria` لشجرة إمكانية الوصول.
- يدعم `snapshot` أيضًا خيارات لقطة الدور (`interactive`, `compact`, `depth`, `selector`) التي تُعيد مراجع مثل `e12`.
- يتطلب `act` `ref` من `snapshot` (قيمة عددية `12` من لقطات الذكاء الاصطناعي، أو `e12` من لقطات الدور)؛ استخدم `evaluate` لاحتياجات محدودة لمحددات CSS.
- تجنّب `act` → `wait` افتراضيًا؛ استخدمه فقط في الحالات الاستثنائية (عدم وجود حالة واجهة موثوقة للانتظار).
- يمكن لـ `upload` تمرير `ref` اختياريًا للنقر التلقائي بعد التجهيز.
- يدعم `upload` أيضًا `inputRef` (مرجع aria) أو `element` (محدد CSS) لضبط `<input type="file">` مباشرةً.

### `canvas`

قيادة لوحة Canvas للعُقدة (present, eval, snapshot, A2UI).

الإجراءات الأساسية:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (يعيد كتلة صورة + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

ملاحظات:

- يستخدم `node.invoke` الخاص بـ Gateway داخليًا.
- إذا لم يتم توفير `node`، تختار الأداة افتراضيًا (عُقدة واحدة متصلة أو عُقدة mac محلية).
- A2UI متاح لإصدار v0.8 فقط (لا `createSurface`)؛ يرفض CLI JSONL لإصدار v0.9 مع أخطاء سطرية.
- فحص سريع: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

اكتشاف واستهداف العُقد المقترنة؛ إرسال الإشعارات؛ التقاط الكاميرا/الشاشة.

الإجراءات الأساسية:

- `status`, `describe`
- `pending`, `approve`, `reject` (الاقتران)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

ملاحظات:

- تتطلب أوامر الكاميرا/الشاشة أن يكون تطبيق العُقدة في الواجهة الأمامية.
- تُعيد الصور كتل صور + `MEDIA:<path>`.
- تُعيد الفيديوهات `FILE:<path>` (mp4).
- يُعيد الموقع حمولة JSON (lat/lon/accuracy/timestamp).
- معلمات `run`: مصفوفة argv لـ `command`؛ اختياريًا `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

مثال (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

تحليل صورة باستخدام نموذج الصور المُهيّأ.

المعلمات الأساسية:

- `image` (مسار أو URL مطلوب)
- `prompt` (اختياري؛ الافتراضي "Describe the image.")
- `model` (تجاوز اختياري)
- `maxBytesMb` (حدّ حجم اختياري)

ملاحظات:

- متاح فقط عند تهيئة `agents.defaults.imageModel` (أساسي أو بدائل)، أو عند إمكانية استنتاج نموذج صور ضمنيًا من نموذجك الافتراضي + اعتماد مُهيّأ (محاولة أفضل).
- يستخدم نموذج الصور مباشرةً (مستقل عن نموذج الدردشة الرئيسي).

### `message`

إرسال الرسائل وإجراءات القنوات عبر Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

الإجراءات الأساسية:

- `send` (نص + وسائط اختيارية؛ يدعم MS Teams أيضًا `card` لبطاقات Adaptive)
- `poll` (استطلاعات WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

ملاحظات:

- يوجّه `send` WhatsApp عبر Gateway؛ القنوات الأخرى مباشرة.
- يستخدم `poll` Gateway لـ WhatsApp وMS Teams؛ بينما تذهب استطلاعات Discord مباشرة.
- عند ربط استدعاء أداة الرسائل بجلسة دردشة نشطة، تُقيَّد الإرسالات بهدف تلك الجلسة لتجنّب تسريبات السياق المتقاطعة.

### `cron`

إدارة مهام cron والتنبيهات في Gateway.

الإجراءات الأساسية:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (إدراج حدث نظام + نبضة فورية اختيارية)

ملاحظات:

- يتوقع `add` كائن مهمة cron كامل (نفس مخطط استدعاء RPC لـ `cron.add`).
- يستخدم `update` `{ jobId, patch }` (يُقبل `id` للتوافق).

### `gateway`

إعادة تشغيل أو تطبيق تحديثات على عملية Gateway الجارية (في المكان).

الإجراءات الأساسية:

- `restart` (تفويض + إرسال `SIGUSR1` لإعادة تشغيل داخل العملية؛ إعادة تشغيل `openclaw gateway` في المكان)
- `config.get` / `config.schema`
- `config.apply` (تحقق + كتابة التهيئة + إعادة تشغيل + إيقاظ)
- `config.patch` (دمج تحديث جزئي + إعادة تشغيل + إيقاظ)
- `update.run` (تشغيل التحديث + إعادة تشغيل + إيقاظ)

ملاحظات:

- استخدم `delayMs` (الافتراضي 2000) لتجنّب مقاطعة رد جارٍ.
- `restart` معطّل افتراضيًا؛ فعّله عبر `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

سرد الجلسات، فحص سجل المحادثة، أو الإرسال إلى جلسة أخرى.

المعلمات الأساسية:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = لا شيء)
- `sessions_history`: `sessionKey` (أو `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (أو `sessionId`), `message`, `timeoutSeconds?` (0 = إرسال دون انتظار)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (الافتراضي الحالي؛ يقبل `sessionId`), `model?` (`default` يمسح التجاوز)

ملاحظات:

- `main` هو مفتاح الدردشة المباشرة القياسي؛ يتم إخفاء العام/غير المعروف.
- يجلب `messageLimit > 0` آخر N رسائل لكل جلسة (مع تصفية رسائل الأدوات).
- ينتظر `sessions_send` الاكتمال النهائي عندما يكون `timeoutSeconds > 0`.
- يتم التسليم/الإعلان بعد الاكتمال وبأفضل جهد؛ يؤكد `status: "ok"` انتهاء تشغيل الوكيل، وليس تسليم الإعلان.
- يبدأ `sessions_spawn` تشغيل وكيل فرعي وينشر رد إعلان إلى دردشة الطالب.
- `sessions_spawn` غير حاجز ويعيد `status: "accepted"` فورًا.
- يُشغّل `sessions_send` تبادل ping‑pong للرد (أرسل `REPLY_SKIP` للإيقاف؛ الحد الأقصى للدورات عبر `session.agentToAgent.maxPingPongTurns`، 0–5).
- بعد ping‑pong، ينفّذ الوكيل الهدف **خطوة إعلان**؛ أرسل `ANNOUNCE_SKIP` لكتم الإعلان.

### `agents_list`

سرد معرّفات الوكلاء التي يمكن للجلسة الحالية استهدافها عبر `sessions_spawn`.

ملاحظات:

- النتيجة مقيّدة بقوائم السماح لكل وكيل (`agents.list[].subagents.allowAgents`).
- عند تهيئة `["*"]`، تتضمن الأداة جميع الوكلاء المُهيّئين وتُعلِّم `allowAny: true`.

## المعلمات (شائعة)

الأدوات المدعومة من Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (الافتراضي `ws://127.0.0.1:18789`)
- `gatewayToken` (إذا كان التحقق مُفعّلًا)
- `timeoutMs`

ملاحظة: عند ضبط `gatewayUrl`، ضمّن `gatewayToken` صراحةً. لا ترث الأدوات التهيئة
أو بيانات اعتماد البيئة للتجاوزات، ويُعد غياب بيانات الاعتماد الصريحة خطأً.

أداة المتصفح:

- `profile` (اختياري؛ الافتراضي `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (اختياري؛ تثبيت معرّف/اسم عُقدة محدد)

## تدفقات الوكيل الموصى بها

أتمتة المتصفح:

1. `browser` → `status` / `start`
2. `snapshot` (ai أو aria)
3. `act` (click/type/press)
4. `screenshot` إذا احتجت تأكيدًا بصريًا

عرض Canvas:

1. `canvas` → `present`
2. `a2ui_push` (اختياري)
3. `snapshot`

استهداف العُقد:

1. `nodes` → `status`
2. `describe` على العُقدة المختارة
3. `notify` / `run` / `camera_snap` / `screen_record`

## السلامة

- تجنّب `system.run` المباشر؛ استخدم `nodes` → `run` فقط بموافقة صريحة من المستخدم.
- احترم موافقة المستخدم لالتقاط الكاميرا/الشاشة.
- استخدم `status/describe` لضمان الأذونات قبل استدعاء أوامر الوسائط.

## كيفية عرض الأدوات للوكيل

تُعرَض الأدوات عبر قناتين متوازيتين:

1. **نص موجه النظام**: قائمة قابلة للقراءة البشرية + إرشادات.
2. **مخطط الأداة**: تعريفات الدوال المنظّمة المُرسلة إلى واجهة برمجة تطبيقات النموذج.

هذا يعني أن الوكيل يرى كلاً من «ما الأدوات الموجودة» و«كيفية استدعائها». إذا لم تظهر أداة
في موجه النظام أو المخطط، فلن يتمكن النموذج من استدعائها.
