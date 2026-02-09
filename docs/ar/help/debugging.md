---
summary: "أدوات تصحيح الأخطاء: وضع المراقبة، تدفّقات النموذج الخام، وتتبع تسرّب الاستدلال"
read_when:
  - تحتاج إلى فحص مخرجات النموذج الخام لرصد تسرّب الاستدلال
  - تريد تشغيل Gateway في وضع المراقبة أثناء التكرار
  - تحتاج إلى سير عمل قابل للتكرار لتصحيح الأخطاء
title: "Debugging"
---

# Debugging

تغطي هذه الصفحة أدوات مساعدة لتصحيح الأخطاء الخاصة بالمخرجات المتدفقة، خصوصًا عندما يمزج موفّر ما الاستدلال مع النص العادي.

## تجاوز تصحيح أخطاء وقت التشغيل

استخدم `/debug` في الدردشة لتعيين تجاوزات تهيئة **وقت التشغيل فقط** (في الذاكرة، وليس على القرص).
يكون `/debug` معطّلًا افتراضيًا؛ فعِّله باستخدام `commands.debug: true`.
يُعدّ هذا مفيدًا عندما تحتاج إلى تبديل إعدادات نادرة دون تحرير `openclaw.json`.

أمثلة:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

يقوم `/debug reset` بمسح جميع التجاوزات والعودة إلى التهيئة الموجودة على القرص.

## وضع مراقبة Gateway

للتكرار السريع، شغِّل Gateway تحت مراقبة الملفات:

```bash
pnpm gateway:watch --force
```

هذه الخرائط إلى:

```bash
tsx watch src/entry.ts gateway --force
```

أضِف أي أعلام CLI خاصة بـ Gateway بعد `gateway:watch` وسيتم تمريرها
عند كل إعادة تشغيل.

## ملف تعريف التطوير + Gateway التطوير (--dev)

استخدم ملف تعريف التطوير لعزل الحالة وتشغيل إعداد آمن ومؤقت لتصحيح الأخطاء. هناك **علَمان** من `--dev`:

- **`--dev` عام (ملف تعريف):** يعزل الحالة تحت `~/.openclaw-dev` ويضبط
  منفذ Gateway الافتراضي على `19001` (وتتحول المنافذ المشتقة معه).
- **`gateway --dev`:** يطلب من Gateway إنشاء تهيئة افتراضية + مساحة عمل تلقائيًا
  عند غيابهما (وتخطي BOOTSTRAP.md).

التدفق الموصى به (ملف تعريف التطوير + إقلاع التطوير):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

إذا لم يكن لديك تثبيت عام بعد، شغِّل CLI عبر `pnpm openclaw ...`.

ما الذي يفعله ذلك:

1. **عزل ملف التعريف** (`--dev` عام)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (يتحوّل المتصفح/اللوحة وفقًا لذلك)

2. **إقلاع التطوير** (`gateway --dev`)
   - يكتب تهيئة دنيا عند غيابها (`gateway.mode=local`، ربط loopback).
   - يعيّن `agent.workspace` إلى مساحة عمل التطوير.
   - يعيّن `agent.skipBootstrap=true` (بدون BOOTSTRAP.md).
   - يزرع ملفات مساحة العمل عند غيابها:
     `AGENTS.md`، `SOUL.md`، `TOOLS.md`، `IDENTITY.md`، `USER.md`، `HEARTBEAT.md`.
   - الهوية الافتراضية: **C3‑PO** (روبوت بروتوكولات).
   - يتخطّى موفّري القنوات في وضع التطوير (`OPENCLAW_SKIP_CHANNELS=1`).

تدفق إعادة الضبط (بداية جديدة):

```bash
pnpm gateway:dev:reset
```

ملاحظة: إن `--dev` علم **عام** لملف التعريف وتلتهمه بعض المشغِّلات.
إذا احتجت إلى كتابته صراحةً، استخدم صيغة متغير البيئة:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

يقوم `--reset` بمسح التهيئة وبيانات الاعتماد والجلسات ومساحة عمل التطوير (باستخدام
`trash`، وليس `rm`)، ثم يعيد إنشاء إعداد التطوير الافتراضي.

نصيحة: إذا كان Gateway غير مخصص للتطوير يعمل بالفعل (launchd/systemd)، فأوقفه أولًا:

```bash
openclaw gateway stop
```

## تسجيل التدفق الخام (OpenClaw)

يمكن لـ OpenClaw تسجيل **تدفّق المساعد الخام** قبل أي ترشيح/تنسيق.
هذه أفضل طريقة لمعرفة ما إذا كان الاستدلال يصل كدلتا نصية عادية
(أم ككتل تفكير منفصلة).

فعِّله عبر CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

تجاوز المسار اختياريًا:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

معادل إنف فار:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

الملف الافتراضي:

`~/.openclaw/logs/raw-stream.jsonl`

## تسجيل المقاطع الخام (pi-mono)

لالتقاط **مقاطع متوافقة مع OpenAI خام** قبل تحليلها إلى كتل،
يوفّر pi-mono مسجّلًا منفصلًا:

```bash
PI_RAW_STREAM=1
```

مسار اختياري:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

الملف الافتراضي:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> ملاحظة: لا يتم إصدار هذا إلا من العمليات التي تستخدم موفّر
> `openai-completions` الخاص بـ pi-mono.

## ملاحظات السلامة

- قد تتضمن سجلات التدفق الخام المطالبات الكاملة، ومخرجات الأدوات، وبيانات المستخدم.
- احتفظ بالسجلات محليًا واحذفها بعد تصحيح الأخطاء.
- إذا شاركت السجلات، فاحرص على تنقيتها من الأسرار ومعلومات التعريف الشخصية (PII) أولًا.
