---
summary: "دعم iMessage القديم عبر imsg ‏(JSON-RPC عبر stdio). يُنصَح بالإعدادات الجديدة باستخدام BlueBubbles."
read_when:
  - إعداد دعم iMessage
  - استكشاف أخطاء إرسال/استقبال iMessage
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:19Z
---

# iMessage (قديم: imsg)

> **موصى به:** استخدم [BlueBubbles](/channels/bluebubbles) لإعدادات iMessage الجديدة.
>
> قناة `imsg` هي تكامل خارجي قديم عبر CLI وقد تتم إزالتها في إصدار مستقبلي.

الحالة: تكامل خارجي قديم عبر CLI. يقوم Gateway بتشغيل `imsg rpc` ‏(JSON-RPC عبر stdio).

## البدء السريع (للمبتدئين)

1. تأكّد من تسجيل الدخول إلى Messages على هذا الـ Mac.
2. ثبّت `imsg`:
   - `brew install steipete/tap/imsg`
3. هيّئ OpenClaw باستخدام `channels.imessage.cliPath` و`channels.imessage.dbPath`.
4. ابدأ تشغيل Gateway ووافق على أي مطالبات من macOS ‏(Automation + Full Disk Access).

التهيئة الدنيا:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## ما هو

- قناة iMessage مدعومة بواسطة `imsg` على macOS.
- توجيه حتمي: تعود الردود دائمًا إلى iMessage.
- تشارك الرسائل الخاصة (DMs) جلسة الوكيل الرئيسية؛ بينما تكون المجموعات معزولة (`agent:<agentId>:imessage:group:<chat_id>`).
- إذا وصل خيط متعدد المشاركين مع `is_group=false`، فلا يزال بإمكانك عزله عبر `chat_id` باستخدام `channels.imessage.groups` (انظر «الخيوط الشبيهة بالمجموعات» أدناه).

## كتابات التهيئة

افتراضيًا، يُسمح لـ iMessage بكتابة تحديثات التهيئة المُحفَّزة بواسطة `/config set|unset` (يتطلب `commands.config: true`).

عطّل ذلك عبر:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## المتطلبات

- macOS مع تسجيل الدخول إلى Messages.
- Full Disk Access لـ OpenClaw + `imsg` (الوصول إلى قاعدة بيانات Messages).
- إذن Automation عند الإرسال.
- يمكن أن يشير `channels.imessage.cliPath` إلى أي أمر يوكّل stdin/stdout (على سبيل المثال، سكربت غلاف يتصل عبر SSH بجهاز Mac آخر ويشغّل `imsg rpc`).

## استكشاف أخطاء خصوصية وأمان macOS ‏TCC وإصلاحها

إذا فشل الإرسال/الاستقبال (على سبيل المثال، خروج `imsg rpc` بقيمة غير صفرية، أو انتهاء المهلة، أو ظهور Gateway وكأنه عالق)، فسبب شائع هو مطالبة أذونات macOS لم تتم الموافقة عليها.

يمنح macOS أذونات TCC لكل تطبيق/سياق عملية. وافق على المطالبات في السياق نفسه الذي يشغّل `imsg` (مثل Terminal/iTerm، أو جلسة LaunchAgent، أو عملية أُطلقت عبر SSH).

قائمة التحقق:

- **Full Disk Access**: اسمح بالوصول للعملية التي تشغّل OpenClaw (وأي غلاف shell/SSH ينفّذ `imsg`). هذا مطلوب لقراءة قاعدة بيانات Messages (`chat.db`).
- **Automation → Messages**: اسمح للعملية التي تشغّل OpenClaw (و/أو الطرفية لديك) بالتحكم في **Messages.app** للإرسال الصادر.
- **سلامة CLI لـ `imsg`**: تحقّق من تثبيت `imsg` ودعمه لـ RPC (`imsg rpc --help`).

نصيحة: إذا كان OpenClaw يعمل دون واجهة (LaunchAgent/systemd/SSH)، فقد يسهل تفويت مطالبة macOS. شغّل أمرًا تفاعليًا لمرة واحدة في طرفية بواجهة رسومية لفرض ظهور المطالبة، ثم أعد المحاولة:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

أذونات مجلدات macOS ذات الصلة (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## الإعداد (المسار السريع)

1. تأكّد من تسجيل الدخول إلى Messages على هذا الـ Mac.
2. هيّئ iMessage وابدأ تشغيل Gateway.

### مستخدم macOS مخصّص للبوت (لهوية معزولة)

إذا أردت أن يرسل البوت من **هوية iMessage منفصلة** (وإبقاء Messages الشخصية نظيفة)، فاستخدم Apple ID مخصّصًا + مستخدم macOS مخصّصًا.

1. أنشئ Apple ID مخصّصًا (مثال: `my-cool-bot@icloud.com`).
   - قد تطلب Apple رقم هاتف للتحقق/المصادقة الثنائية.
2. أنشئ مستخدم macOS (مثال: `openclawhome`) وسجّل الدخول إليه.
3. افتح Messages ضمن مستخدم macOS هذا وسجّل الدخول إلى iMessage باستخدام Apple ID الخاص بالبوت.
4. فعّل Remote Login ‏(إعدادات النظام → عام → المشاركة → Remote Login).
5. ثبّت `imsg`:
   - `brew install steipete/tap/imsg`
6. اضبط SSH بحيث يعمل `ssh <bot-macos-user>@localhost true` دون كلمة مرور.
7. وجّه `channels.imessage.accounts.bot.cliPath` إلى غلاف SSH يشغّل `imsg` كمستخدم البوت.

ملاحظة التشغيل الأول: قد يتطلّب الإرسال/الاستقبال موافقات واجهة رسومية (Automation + Full Disk Access) ضمن _مستخدم macOS الخاص بالبوت_. إذا بدا `imsg rpc` عالقًا أو خرج، فسجّل الدخول إلى ذلك المستخدم (يساعد Screen Sharing)، وشغّل أمرًا لمرة واحدة `imsg chats --limit 1` / `imsg send ...`، ووافق على المطالبات، ثم أعد المحاولة. راجع [استكشاف أخطاء خصوصية وأمان macOS ‏TCC وإصلاحها](#troubleshooting-macos-privacy-and-security-tcc).

غلاف مثال (`chmod +x`). استبدل `<bot-macos-user>` باسم مستخدم macOS الفعلي لديك:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

تهيئة مثال:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

للإعدادات ذات الحساب الواحد، استخدم الخيارات المسطّحة (`channels.imessage.cliPath`، `channels.imessage.dbPath`) بدل خريطة `accounts`.

### متغير عن بُعد/SSH (اختياري)

إذا أردت iMessage على Mac آخر، فاضبط `channels.imessage.cliPath` على غلاف يشغّل `imsg` على مضيف macOS البعيد عبر SSH. يحتاج OpenClaw فقط إلى stdio.

غلاف مثال:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**المرفقات عن بُعد:** عندما يشير `cliPath` إلى مضيف بعيد عبر SSH، فإن مسارات المرفقات في قاعدة بيانات Messages تشير إلى ملفات على الجهاز البعيد. يمكن لـ OpenClaw جلبها تلقائيًا عبر SCP بتعيين `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

إذا لم يتم تعيين `remoteHost`، يحاول OpenClaw اكتشافه تلقائيًا عبر تحليل أمر SSH في سكربت الغلاف لديك. يُنصَح بالتهيئة الصريحة للموثوقية.

#### Mac بعيد عبر Tailscale (مثال)

إذا كان Gateway يعمل على مضيف/آلة افتراضية Linux لكن يجب أن يعمل iMessage على Mac، فإن Tailscale هو الجسر الأبسط: يتواصل Gateway مع الـ Mac عبر tailnet، ويشغّل `imsg` عبر SSH، ويجلب المرفقات عبر SCP.

البنية:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

مثال تهيئة عملي (اسم مضيف Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

غلاف مثال (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

ملاحظات:

- تأكّد من تسجيل الدخول إلى Messages على الـ Mac، وتمكين Remote Login.
- استخدم مفاتيح SSH لكي يعمل `ssh bot@mac-mini.tailnet-1234.ts.net` دون مطالبات.
- يجب أن يطابق `remoteHost` هدف SSH حتى يتمكن SCP من جلب المرفقات.

دعم تعدد الحسابات: استخدم `channels.imessage.accounts` مع تهيئة لكل حساب و`name` اختياري. راجع [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) للنمط المشترك. لا تُدرج `~/.openclaw/openclaw.json` في المستودع (غالبًا ما يحتوي على رموز).

## التحكم في الوصول (الرسائل الخاصة + المجموعات)

الرسائل الخاصة (DMs):

- الافتراضي: `channels.imessage.dmPolicy = "pairing"`.
- يتلقى المرسلون غير المعروفين رمز اقتران؛ تُتجاهل الرسائل حتى تتم الموافقة (تنتهي صلاحية الرموز بعد ساعة واحدة).
- الموافقة عبر:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- الاقتران هو تبادل الرموز الافتراضي لرسائل iMessage الخاصة. التفاصيل: [الاقتران](/channels/pairing)

المجموعات:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- يتحكم `channels.imessage.groupAllowFrom` بمن يمكنه الإطلاق في المجموعات عند تعيين `allowlist`.
- يعتمد تقييد الذِكر على `agents.list[].groupChat.mentionPatterns` (أو `messages.groupChat.mentionPatterns`) لأن iMessage لا يملك بيانات وصفية أصلية للذِكر.
- تجاوز متعدد الوكلاء: عيّن أنماطًا لكل وكيل على `agents.list[].groupChat.mentionPatterns`.

## كيف يعمل (السلوك)

- يقوم `imsg` ببث أحداث الرسائل؛ ويقوم Gateway بتوحيدها ضمن غلاف القناة المشترك.
- تُوجَّه الردود دائمًا إلى المعرّف نفسه للمحادثة أو المقبض.

## الخيوط الشبيهة بالمجموعات (`is_group=false`)

قد تحتوي بعض خيوط iMessage على عدة مشاركين لكنها تصل مع `is_group=false` اعتمادًا على كيفية تخزين Messages لمعرّف الدردشة.

إذا قمت بتهيئة `chat_id` صراحةً ضمن `channels.imessage.groups`، فسيتعامل OpenClaw مع ذلك الخيط باعتباره «مجموعة» من أجل:

- عزل الجلسات (مفتاح جلسة `agent:<agentId>:imessage:group:<chat_id>` منفصل)
- سلوك قوائم السماح للمجموعات / تقييد الذِكر

مثال:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

هذا مفيد عندما تريد شخصية/نموذجًا معزولًا لخيط معيّن (راجع [توجيه متعدد الوكلاء](/concepts/multi-agent)). لعزل نظام الملفات، راجع [Sandboxing](/gateway/sandboxing).

## الوسائط + الحدود

- استيعاب اختياري للمرفقات عبر `channels.imessage.includeAttachments`.
- حد الوسائط عبر `channels.imessage.mediaMaxMb`.

## الحدود

- يُجزَّأ النص الصادر إلى `channels.imessage.textChunkLimit` (الافتراضي 4000).
- تجزئة اختيارية حسب الأسطر الجديدة: عيّن `channels.imessage.chunkMode="newline"` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التجزئة حسب الطول.
- تُقيَّد تحميلات الوسائط بواسطة `channels.imessage.mediaMaxMb` (الافتراضي 16).

## العنونة / أهداف التسليم

فضّل `chat_id` للتوجيه المستقر:

- `chat_id:123` (المفضّل)
- `chat_guid:...`
- `chat_identifier:...`
- مقابض مباشرة: `imessage:+1555` / `sms:+1555` / `user@example.com`

سرد الدردشات:

```
imsg chats --limit 20
```

## مرجع التهيئة (iMessage)

التهيئة الكاملة: [التهيئة](/gateway/configuration)

خيارات الموفّر:

- `channels.imessage.enabled`: تمكين/تعطيل بدء القناة.
- `channels.imessage.cliPath`: مسار `imsg`.
- `channels.imessage.dbPath`: مسار قاعدة بيانات Messages.
- `channels.imessage.remoteHost`: مضيف SSH لنقل مرفقات SCP عندما يشير `cliPath` إلى Mac بعيد (مثل `user@gateway-host`). يتم الاكتشاف تلقائيًا من غلاف SSH إذا لم يُضبط.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: منطقة SMS.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (الافتراضي: الاقتران).
- `channels.imessage.allowFrom`: قائمة السماح للرسائل الخاصة (مقابض، بريد إلكتروني، أرقام E.164، أو `chat_id:*`). يتطلب `open` ‏`"*"`. لا يملك iMessage أسماء مستخدمين؛ استخدم المقابض أو أهداف الدردشة.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (الافتراضي: قائمة السماح).
- `channels.imessage.groupAllowFrom`: قائمة سماح مرسلي المجموعات.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: الحد الأقصى لرسائل المجموعات المُضمَّنة كسياق (0 يعطّل).
- `channels.imessage.dmHistoryLimit`: حد سجل الرسائل الخاصة بوحدات أدوار المستخدم. تجاوزات لكل مستخدم: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: افتراضيات لكل مجموعة + قائمة السماح (استخدم `"*"` للافتراضيات العامة).
- `channels.imessage.includeAttachments`: استيعاب المرفقات ضمن السياق.
- `channels.imessage.mediaMaxMb`: حد الوسائط الواردة/الصادرة (ميغابايت).
- `channels.imessage.textChunkLimit`: حجم تجزئة الإرسال (محارف).
- `channels.imessage.chunkMode`: `length` (الافتراضي) أو `newline` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التجزئة حسب الطول.

خيارات عامة ذات صلة:

- `agents.list[].groupChat.mentionPatterns` (أو `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
