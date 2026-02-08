---
summary: "دليل شامل من البداية إلى النهاية لتشغيل OpenClaw كمساعد شخصي مع تنبيهات السلامة"
read_when:
  - "تهيئة مثيل مساعد جديد"
  - "مراجعة تبعات السلامة والأذونات"
title: "إعداد المساعد الشخصي"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:50Z
---

# بناء مساعد شخصي باستخدام OpenClaw

OpenClaw هو Gateway لـ WhatsApp + Telegram + Discord + iMessage لوكلاء **Pi**. تضيف الإضافات Mattermost. يوضح هذا الدليل إعداد «المساعد الشخصي»: رقم WhatsApp مخصص واحد يتصرف كوكيلك الدائم التشغيل.

## ⚠️ السلامة أولاً

أنت تضع وكيلاً في موضع يتيح له:

- تشغيل أوامر على جهازك (اعتمادًا على إعداد أداة Pi لديك)
- قراءة/كتابة الملفات داخل مساحة عملك
- إرسال رسائل للخارج عبر WhatsApp/Telegram/Discord/Mattermost (إضافة)

ابدأ بتحفظ:

- اضبط دائمًا `channels.whatsapp.allowFrom` (لا تشغّل مفتوحًا على العالم على جهاز Mac الشخصي).
- استخدم رقم WhatsApp مخصصًا للمساعد.
- أصبحت نبضات القلب افتراضيًا كل 30 دقيقة. عطّلها حتى تثق بالإعداد عبر تعيين `agents.defaults.heartbeat.every: "0m"`.

## المتطلبات المسبقة

- تثبيت OpenClaw وإتمام التهيئة الأولية — راجع [بدء الاستخدام](/start/getting-started) إن لم تفعل ذلك بعد
- رقم هاتف ثانٍ (SIM/eSIM/مدفوع مسبقًا) للمساعد

## إعداد الهاتفين (موصى به)

هذا ما تريده:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

إذا ربطت WhatsApp الشخصي بـ OpenClaw، فكل رسالة تصلك تصبح «مدخلات للوكيل». نادرًا ما يكون هذا ما تريده.

## بدء سريع خلال 5 دقائق

1. إقران WhatsApp Web (يعرض رمز QR؛ امسحه بهاتف المساعد):

```bash
openclaw channels login
```

2. تشغيل Gateway (اتركه قيد التشغيل):

```bash
openclaw gateway --port 18789
```

3. ضع تهيئة بسيطة في `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

الآن أرسل رسالة إلى رقم المساعد من هاتفك المدرج في قائمة السماح.

عند انتهاء التهيئة الأولية، نفتح لوحة التحكم تلقائيًا ونطبع رابطًا نظيفًا (غير مُرمَّز). إذا طلب المصادقة، الصق الرمز من `gateway.auth.token` ضمن إعدادات واجهة التحكم. لإعادة الفتح لاحقًا: `openclaw dashboard`.

## امنح الوكيل مساحة عمل (AGENTS)

يقرأ OpenClaw تعليمات التشغيل و«الذاكرة» من دليل مساحة العمل الخاص به.

افتراضيًا، يستخدم OpenClaw `~/.openclaw/workspace` كمساحة عمل للوكيل، وسيُنشئه (إضافةً إلى ملفات البداية `AGENTS.md` و`SOUL.md` و`TOOLS.md` و`IDENTITY.md` و`USER.md` و`HEARTBEAT.md`) تلقائيًا عند الإعداد/تشغيل الوكيل لأول مرة. يتم إنشاء `BOOTSTRAP.md` فقط عندما تكون مساحة العمل جديدة تمامًا (ولا ينبغي أن تعود بعد حذفها). الملف `MEMORY.md` اختياري (لا يُنشأ تلقائيًا)؛ وعند وجوده يتم تحميله للجلسات العادية. جلسات الوكلاء الفرعيين تحقن فقط `AGENTS.md` و`TOOLS.md`.

نصيحة: تعامل مع هذا المجلد على أنه «ذاكرة» OpenClaw واجعله مستودع git (ويُفضّل أن يكون خاصًا) كي تُحفظ ملفات `AGENTS.md` + الذاكرة احتياطيًا. إذا كان git مثبتًا، تُهيَّأ مساحات العمل الجديدة تلقائيًا.

```bash
openclaw setup
```

مخطط مساحة العمل الكامل + دليل النسخ الاحتياطي: [مساحة عمل الوكيل](/concepts/agent-workspace)
سير عمل الذاكرة: [الذاكرة](/concepts/memory)

اختياري: اختر مساحة عمل مختلفة باستخدام `agents.defaults.workspace` (يدعم `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

إذا كنت تشحن بالفعل ملفات مساحة عملك من مستودع، يمكنك تعطيل إنشاء ملفات الإقلاع بالكامل:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## التهيئة التي تحوله إلى «مساعد»

يأتي OpenClaw افتراضيًا بإعداد مساعد جيد، لكنك غالبًا سترغب في الضبط:

- الشخصية/التعليمات في `SOUL.md`
- افتراضات التفكير (إن رغبت)
- نبضات القلب (بعد أن تثق به)

مثال:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## الجلسات والذاكرة

- ملفات الجلسة: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- بيانات الجلسة الوصفية (استخدام الرموز، آخر مسار، إلخ): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (قديم: `~/.openclaw/sessions/sessions.json`)
- يبدئ `/new` أو `/reset` جلسة جديدة لتلك الدردشة (قابل للضبط عبر `resetTriggers`). إذا أُرسل وحده، يرد الوكيل بتحية قصيرة لتأكيد إعادة الضبط.
- يقوم `/compact [instructions]` بضغط سياق الجلسة ويُبلغ عن ميزانية السياق المتبقية.

## نبضات القلب (الوضع الاستباقي)

افتراضيًا، يشغّل OpenClaw نبضة قلب كل 30 دقيقة مع الموجه:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
اضبط `agents.defaults.heartbeat.every: "0m"` للتعطيل.

- إذا كان `HEARTBEAT.md` موجودًا لكنه فارغ فعليًا (أسطر فارغة فقط وعناوين markdown مثل `# Heading`)، يتخطّى OpenClaw تشغيل نبضة القلب لتوفير استدعاءات API.
- إذا كان الملف مفقودًا، تستمر نبضة القلب ويقرر النموذج ما يفعل.
- إذا ردّ الوكيل بـ `HEARTBEAT_OK` (اختياريًا مع حشو قصير؛ انظر `agents.defaults.heartbeat.ackMaxChars`)، يكبح OpenClaw التسليم الصادر لتلك النبضة.
- تشغّل نبضات القلب دورات وكيل كاملة — الفواصل الأقصر تستهلك رموزًا أكثر.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## الوسائط الواردة والصادرة

يمكن إظهار المرفقات الواردة (صور/صوت/مستندات) لأمرك عبر القوالب:

- `{{MediaPath}}` (مسار ملف مؤقت محلي)
- `{{MediaUrl}}` (عنوان شبه URL)
- `{{Transcript}}` (إذا كان تفريغ الصوت مُفعّلًا)

المرفقات الصادرة من الوكيل: أدرج `MEDIA:<path-or-url>` في سطر مستقل (من دون مسافات). مثال:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

يستخرج OpenClaw هذه ويرسلها كوسائط إلى جانب النص.

## قائمة تدقيق التشغيل

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

توجد السجلات ضمن `/tmp/openclaw/` (الافتراضي: `openclaw-YYYY-MM-DD.log`).

## الخطوات التالية

- WebChat: [WebChat](/web/webchat)
- عمليات Gateway: [دليل تشغيل Gateway](/gateway)
- Cron + الإيقاظ: [مهام Cron](/automation/cron-jobs)
- التطبيق المُرافق لشريط قائمة macOS: [تطبيق OpenClaw لنظام macOS](/platforms/macos)
- تطبيق عُقدة iOS: [تطبيق iOS](/platforms/ios)
- تطبيق عُقدة Android: [تطبيق Android](/platforms/android)
- حالة Windows: [Windows (WSL2)](/platforms/windows)
- حالة Linux: [تطبيق Linux](/platforms/linux)
- الأمان: [الأمان](/gateway/security)
