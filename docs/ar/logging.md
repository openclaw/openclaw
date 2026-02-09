---
summary: "نظرة عامة على التسجيل: سجلات الملفات، مخرجات وحدة التحكم، تتبّع CLI، وواجهة التحكم"
read_when:
  - تحتاج إلى نظرة عامة سهلة للمبتدئين حول التسجيل
  - تريد تهيئة مستويات أو تنسيقات السجل
  - تقوم باستكشاف الأخطاء وإصلاحها وتحتاج إلى العثور على السجلات بسرعة
title: "التسجيل"
---

# التسجيل

يقوم OpenClaw بالتسجيل في مكانين:

- **سجلات الملفات** (أسطر JSON) التي يكتبها Gateway.
- **مخرجات وحدة التحكم** المعروضة في الطرفيات وواجهة التحكم.

تشرح هذه الصفحة أماكن وجود السجلات، وكيفية قراءتها، وكيفية تهيئة مستويات
وتنسيقات السجل.

## أين توجد السجلات

افتراضيًا، يكتب Gateway ملف سجل متداول ضمن:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

يستخدم التاريخ المنطقة الزمنية المحلية لمضيف Gateway.

يمكنك تجاوز ذلك في `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## كيفية قراءة السجلات

### CLI: تتبّع مباشر (موصى به)

استخدم CLI لتتبّع ملف سجل Gateway عبر RPC:

```bash
openclaw logs --follow
```

أوضاع الإخراج:

- **جلسات TTY**: أسطر سجل منسّقة، ملوّنة، وبنية منظمة.
- **جلسات غير TTY**: نص عادي.
- `--json`: JSON مفصول بأسطر (حدث سجل واحد لكل سطر).
- `--plain`: فرض النص العادي في جلسات TTY.
- `--no-color`: تعطيل ألوان ANSI.

في وضع JSON، يصدر CLI كائنات موسومة بـ `type`:

- `meta`: بيانات وصفية للتدفق (الملف، المؤشر، الحجم)
- `log`: إدخال سجل مُحلّل
- `notice`: تلميحات الاقتطاع/التدوير
- `raw`: سطر سجل غير مُحلّل

إذا تعذّر الوصول إلى Gateway، يطبع CLI تلميحًا قصيرًا لتشغيل:

```bash
openclaw doctor
```

### واجهة التحكم (الويب)

تقوم علامة التبويب **Logs** في واجهة التحكم بتتبّع الملف نفسه باستخدام `logs.tail`.
راجع [/web/control-ui](/web/control-ui) لمعرفة كيفية فتحها.

### سجلات القنوات فقط

لتصفية نشاط القنوات (WhatsApp/Telegram/إلخ)، استخدم:

```bash
openclaw channels logs --channel whatsapp
```

## تنسيقات السجل

### سجلات الملفات (JSONL)

كل سطر في ملف السجل هو كائن JSON. يقوم كل من CLI وواجهة التحكم بتحليل هذه
الإدخالات لعرض مخرجات منظّمة (الوقت، المستوى، النظام الفرعي، الرسالة).

### مخرجات وحدة التحكم

سجلات وحدة التحكم **مدركة لـ TTY** ومُنسّقة لسهولة القراءة:

- بادئات الأنظمة الفرعية (مثل `gateway/channels/whatsapp`)
- تلوين المستويات (info/warn/error)
- وضع مضغوط اختياري أو وضع JSON

يتم التحكم في تنسيق وحدة التحكم عبر `logging.consoleStyle`.

## تهيئة التسجيل

توجد جميع تهيئات التسجيل ضمن `logging` في `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### مستويات السجل

- `logging.level`: مستوى **سجلات الملفات** (JSONL).
- `logging.consoleLevel`: مستوى تفصيل **وحدة التحكم**.

يؤثر `--verbose` على مخرجات وحدة التحكم فقط؛ ولا يغيّر مستويات سجل الملفات.

### أنماط وحدة التحكم

`logging.consoleStyle`:

- `pretty`: مناسب للبشر، ملوّن، مع طوابع زمنية.
- `compact`: إخراج أكثر إحكامًا (الأفضل للجلسات الطويلة).
- `json`: JSON لكل سطر (لمعالجات السجلات).

### التنقيح (Redaction)

يمكن لملخصات الأدوات تنقيح الرموز الحساسة قبل وصولها إلى وحدة التحكم:

- `logging.redactSensitive`: `off` | `tools` (الافتراضي: `tools`)
- `logging.redactPatterns`: قائمة بسلاسل regex لتجاوز المجموعة الافتراضية

يؤثر التنقيح على **مخرجات وحدة التحكم فقط** ولا يغيّر سجلات الملفات.

## التشخيص + OpenTelemetry

التشخيصات هي أحداث منظّمة وقابلة للقراءة آليًا لتشغيلات النماذج **و**
قياس تدفق الرسائل (webhooks، الطوابير، حالة الجلسة). وهي **لا**
تستبدل السجلات؛ بل توجد لتغذية المقاييس والتتبعات والمصدّرات الأخرى.

تُصدر أحداث التشخيص داخل العملية، لكن لا يتم إرفاق المصدّرات إلا عند تمكين
التشخيصات + إضافة المصدّر.

### OpenTelemetry مقابل OTLP

- **OpenTelemetry (OTel)**: نموذج البيانات + حِزم SDK للتتبعات والمقاييس والسجلات.
- **OTLP**: بروتوكول النقل المستخدم لتصدير بيانات OTel إلى مُجمِّع/خلفية.
- يقوم OpenClaw بالتصدير عبر **OTLP/HTTP (protobuf)** حاليًا.

### الإشارات المُصدَّرة

- **المقاييس**: عدّادات + مُدرّجات (استخدام الرموز، تدفق الرسائل، الطوابير).
- **التتبعات**: مقاطع (spans) لاستخدام النموذج + معالجة webhooks/الرسائل.
- **السجلات**: تُصدَّر عبر OTLP عند تمكين `diagnostics.otel.logs`. يمكن أن يكون
  حجم السجل مرتفعًا؛ ضع `logging.level` ومرشحات المصدّر في الاعتبار.

### فهرس أحداث التشخيص

استخدام النموذج:

- `model.usage`: الرموز، التكلفة، المدة، السياق، المزوّد/النموذج/القناة، معرّفات الجلسة.

تدفق الرسائل:

- `webhook.received`: دخول webhook لكل قناة.
- `webhook.processed`: معالجة webhook + المدة.
- `webhook.error`: أخطاء معالج webhook.
- `message.queued`: إدراج رسالة في الطابور للمعالجة.
- `message.processed`: النتيجة + المدة + خطأ اختياري.

الطوابير + الجلسات:

- `queue.lane.enqueue`: إدراج مسار طابور الأوامر + العمق.
- `queue.lane.dequeue`: سحب مسار طابور الأوامر + زمن الانتظار.
- `session.state`: انتقال حالة الجلسة + السبب.
- `session.stuck`: تحذير تعثّر الجلسة + العمر.
- `run.attempt`: بيانات إعادة المحاولة/المحاولة للتشغيل.
- `diagnostic.heartbeat`: عدّادات مجمّعة (webhooks/الطابور/الجلسة).

### تمكين التشخيص (من دون مُصدِّر)

استخدم هذا إذا كنت تريد إتاحة أحداث التشخيص للإضافات أو المصارف المخصّصة:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### أعلام التشخيص (سجلات مستهدفة)

استخدم الأعلام لتشغيل سجلات تصحيح إضافية ومحددة دون رفع `logging.level`.
الأعلام غير حساسة لحالة الأحرف وتدعم أحرف البدل (مثل `telegram.*` أو `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

تجاوز الإنف (لمرة واحدة):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

ملاحظات:

- تذهب سجلات الأعلام إلى ملف السجل القياسي (نفس `logging.file`).
- يظل الإخراج منقّحًا وفق `logging.redactSensitive`.
- الدليل الكامل: [/diagnostics/flags](/diagnostics/flags).

### التصدير إلى OpenTelemetry

يمكن تصدير التشخيصات عبر إضافة `diagnostics-otel` (OTLP/HTTP). يعمل ذلك
مع أي مُجمِّع/خلفية OpenTelemetry تقبل OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

ملاحظات:

- يمكنك أيضًا تمكين الإضافة باستخدام `openclaw plugins enable diagnostics-otel`.
- يدعم `protocol` حاليًا `http/protobuf` فقط. يتم تجاهل `grpc`.
- تشمل المقاييس استخدام الرموز، التكلفة، حجم السياق، مدة التشغيل، وعدّادات/مدرّجات
  تدفق الرسائل (webhooks، الطوابير، حالة الجلسة، عمق/انتظار الطابور).
- يمكن تبديل التتبعات/المقاييس باستخدام `traces` / `metrics` (الافتراضي: مفعّل). تشمل التتبعات
  مقاطع استخدام النموذج بالإضافة إلى مقاطع معالجة webhooks/الرسائل عند التمكين.
- عيّن `headers` عندما يتطلب المُجمِّع المصادقة.
- متغيرات البيئة المدعومة: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### المقاييس المُصدَّرة (الأسماء + الأنواع)

استخدام النموذج:

- `openclaw.tokens` (عداد، السمات: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (عداد، السمات: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (مُدرّج، السمات: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (مُدرّج، السمات: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

تدفق الرسائل:

- `openclaw.webhook.received` (عداد، السمات: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (عداد، السمات: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (مُدرّج، السمات: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (عداد، السمات: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (عداد، السمات: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (مُدرّج، السمات: `openclaw.channel`,
  `openclaw.outcome`)

الطوابير + الجلسات:

- `openclaw.queue.lane.enqueue` (عداد، السمات: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (عداد، السمات: `openclaw.lane`)
- `openclaw.queue.depth` (مُدرّج، السمات: `openclaw.lane` أو
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (مُدرّج، السمات: `openclaw.lane`)
- `openclaw.session.state` (عداد، السمات: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (عداد، السمات: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (مُدرّج، السمات: `openclaw.state`)
- `openclaw.run.attempt` (عداد، السمات: `openclaw.attempt`)

### المقاطع المُصدَّرة (الأسماء + السمات الرئيسية)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### أخذ العينات + التفريغ

- أخذ عينات التتبّع: `diagnostics.otel.sampleRate` (0.0–1.0، المقاطع الجذرية فقط).
- فترة تصدير المقاييس: `diagnostics.otel.flushIntervalMs` (حد أدنى 1000ms).

### ملاحظات البروتوكول

- يمكن تعيين نقاط نهاية OTLP/HTTP عبر `diagnostics.otel.endpoint` أو
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- إذا كانت نقطة النهاية تحتوي بالفعل على `/v1/traces` أو `/v1/metrics`، فسيتم استخدامها كما هي.
- إذا كانت نقطة النهاية تحتوي بالفعل على `/v1/logs`، فسيتم استخدامها كما هي للسجلات.
- يمكّن `diagnostics.otel.logs` تصدير سجلات OTLP لمخرجات المُسجِّل الرئيسي.

### سلوك تصدير السجلات

- تستخدم سجلات OTLP السجلات المنظّمة نفسها المكتوبة إلى `logging.file`.
- تلتزم بـ `logging.level` (مستوى سجل الملفات). لا ينطبق تنقيح وحدة التحكم
  على سجلات OTLP.
- يُفضَّل في التركيبات ذات الحجم العالي استخدام أخذ عينات/ترشيح مُجمِّع OTLP.

## نصائح استكشاف الأخطاء وإصلاحها

- **Gateway غير قابل للوصول؟** شغّل `openclaw doctor` أولًا.
- **السجلات فارغة؟** تحقّق من أن Gateway يعمل ويكتب إلى مسار الملف
  في `logging.file`.
- **تحتاج إلى مزيد من التفاصيل؟** اضبط `logging.level` على `debug` أو `trace` ثم أعد المحاولة.
