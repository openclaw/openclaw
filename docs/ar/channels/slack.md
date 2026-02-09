---
summary: "إعداد Slack لوضع Socket أو وضع Webhook عبر HTTP"
read_when: "عند إعداد Slack أو استكشاف أخطاء وضع Socket/HTTP في Slack"
title: "Slack"
---

# Slack

## وضع Socket (الافتراضي)

### إعداد سريع (للمبتدئين)

1. أنشئ تطبيق Slack وفعّل **Socket Mode**.
2. أنشئ **App Token** (`xapp-...`) و**Bot Token** (`xoxb-...`).
3. عيّن الرموز لـ OpenClaw وابدأ الـ Gateway.

التهيئة الدنيا:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### الإعداد

1. أنشئ تطبيق Slack (From scratch) في [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → فعّل الخيار. ثم انتقل إلى **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** مع النطاق `connections:write`. انسخ **App Token** (`xapp-...`).
3. **OAuth & Permissions** → أضف نطاقات رمز البوت (استخدم البيان أدناه). انقر **Install to Workspace**. انسخ **Bot User OAuth Token** (`xoxb-...`).
4. اختياري: **OAuth & Permissions** → أضف **User Token Scopes** (انظر قائمة القراءة فقط أدناه). أعد تثبيت التطبيق وانسخ **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → فعّل الأحداث واشترك في:
   - `message.*` (يتضمن التعديلات/الحذف/بثّ سلاسل المحادثات)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. ادعُ البوت إلى القنوات التي تريد أن يقرأها.
7. الأوامر المائلة → أنشئ `/openclaw` إذا كنت تستخدم `channels.slack.slashCommand`. إذا فعّلت الأوامر الأصلية، فأضف أمرًا مائلًا واحدًا لكل أمر مدمج (بنفس أسماء `/help`). الوضع الافتراضي للأوامر الأصلية في Slack هو الإيقاف ما لم تضبط `channels.slack.commands.native: true` (القيمة العامة `commands.native` هي `"auto"` والتي تُبقي Slack مُعطّلًا).
8. **App Home** → فعّل **Messages Tab** حتى يتمكن المستخدمون من مراسلة البوت مباشرة.

استخدم البيان أدناه كي تبقى النطاقات والأحداث متزامنة.

دعم تعدد الحسابات: استخدم `channels.slack.accounts` مع رموز لكل حساب وخيار `name` الاختياري. راجع [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) للنمط المشترك.

### تهيئة OpenClaw (وضع Socket)

تعيين الرموز المميزة عن طريق vars env (مستحسن):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

أو عبر التهيئة:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### رمز المستخدم (اختياري)

يمكن لـ OpenClaw استخدام رمز مستخدم Slack (`xoxp-...`) لعمليات القراءة (السجل،
التثبيتات، التفاعلات، الرموز التعبيرية، معلومات الأعضاء). افتراضيًا يبقى هذا للقراءة فقط: تفضّل القراءات رمز المستخدم عند توفره، بينما تستمر الكتابات باستخدام رمز البوت ما لم تختَر خلاف ذلك صراحةً. حتى مع `userTokenReadOnly: false`، يبقى رمز البوت مفضّلًا للكتابة عند توفره.

تُضبط رموز المستخدم في ملف التهيئة (لا يوجد دعم لمتغيرات البيئة). ولتعدد الحسابات، اضبط `channels.slack.accounts.<id>.userToken`.

مثال باستخدام رموز البوت + التطبيق + المستخدم:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

مثال مع تعيين userTokenReadOnly صراحةً (السماح بكتابات رمز المستخدم):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### استخدام الرموز

- عمليات القراءة (السجل، قائمة التفاعلات، قائمة التثبيتات، قائمة الرموز التعبيرية، معلومات الأعضاء،
  البحث) تفضّل رمز المستخدم عند تهيئته، وإلا فترمز البوت.
- عمليات الكتابة (إرسال/تعديل/حذف الرسائل، إضافة/إزالة التفاعلات، تثبيت/إلغاء تثبيت،
  رفع الملفات) تستخدم رمز البوت افتراضيًا. إذا كان `userTokenReadOnly: false` ولا يتوفر رمز بوت،
  يلجأ OpenClaw إلى رمز المستخدم.

### سياق السجل

- يتحكم `channels.slack.historyLimit` (أو `channels.slack.accounts.*.historyLimit`) في عدد رسائل القناة/المجموعة الحديثة التي تُضمَّن في الموجّه.
- يعود افتراضيًا إلى `messages.groupChat.historyLimit`. عيّن `0` للتعطيل (الافتراضي 50).

## وضع HTTP (واجهة الأحداث)

استخدم وضع Webhook عبر HTTP عندما يكون الـ Gateway قابلاً للوصول من Slack عبر HTTPS (وهو شائع في نشر الخوادم).
يستخدم وضع HTTP واجهة الأحداث + التفاعلية + الأوامر المائلة مع عنوان طلب مشترك.

### الإعداد (وضع HTTP)

1. أنشئ تطبيق Slack و**عطّل Socket Mode** (اختياري إذا كنت تستخدم HTTP فقط).
2. **Basic Information** → انسخ **Signing Secret**.
3. **OAuth & Permissions** → ثبّت التطبيق وانسخ **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → فعّل الأحداث وعيّن **Request URL** إلى مسار Webhook للـ Gateway (الافتراضي `/slack/events`).
5. **Interactivity & Shortcuts** → فعّل وعيّن **Request URL** نفسه.
6. **Slash Commands** → عيّن **Request URL** نفسه لأوامرك.

مثال على عنوان الطلب:
`https://gateway-host/slack/events`

### تهيئة OpenClaw (الحد الأدنى)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

وضع HTTP متعدد الحسابات: اضبط `channels.slack.accounts.<id>.mode = "http"` وقدّم
`webhookPath` فريدًا لكل حساب بحيث يشير كل تطبيق Slack إلى عنوان URL خاص به.

### البيان (اختياري)

استخدم بيان تطبيق Slack هذا لإنشاء التطبيق بسرعة (عدّل الاسم/الأمر إذا رغبت). ضمّن
نطاقات المستخدم إذا كنت تخطط لتهيئة رمز مستخدم.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

إذا فعّلت الأوامر الأصلية، فأضف إدخال `slash_commands` واحدًا لكل أمر تريد كشفه (مطابقًا لقائمة `/help`). تجاوز ذلك باستخدام `channels.slack.commands.native`.

## النطاقات (الحالية مقابل الاختيارية)

واجهة محادثات Slack مُقيّدة حسب النوع: لا تحتاج إلا النطاقات لأنواع المحادثات التي تتعامل معها فعليًا
(قنوات، مجموعات، im، mpim). راجع
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) للنظرة العامة.

### نطاقات رمز البوت (مطلوبة)

- `chat:write` (إرسال/تحديث/حذف الرسائل عبر `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (فتح الرسائل المباشرة عبر `conversations.open` لرسائل المستخدم)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (البحث عن المستخدم)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (الرفع عبر `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### نطاقات رمز المستخدم (اختيارية، قراءة فقط افتراضيًا)

أضف هذه ضمن **User Token Scopes** إذا قمت بتهيئة `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### غير مطلوبة حاليًا (لكن محتملة مستقبلًا)

- `mpim:write` (فقط إذا أضفنا فتح DM جماعي/بدء DM عبر `conversations.open`)
- `groups:write` (فقط إذا أضفنا إدارة القنوات الخاصة: إنشاء/إعادة تسمية/دعوة/أرشفة)
- `chat:write.public` (فقط إذا أردنا النشر في قنوات لا يكون البوت عضوًا فيها)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (فقط إذا احتجنا حقول البريد الإلكتروني من `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (فقط إذا بدأنا سرد/قراءة بيانات تعريف الملفات)

## التهيئة

يستخدم Slack وضع Socket فقط (لا يوجد خادم Webhook عبر HTTP). قدّم كلا الرمزين:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

يمكن أيضا توفير العملات الرمزية عن طريق nv vars:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

تُتحكَّم تفاعلات الإقرار عالميًا عبر `messages.ackReaction` +
`messages.ackReactionScope`. استخدم `messages.removeAckAfterReply` لمسح
تفاعل الإقرار بعد رد البوت.

## الحدود

- يُجزّأ النص الصادر إلى `channels.slack.textChunkLimit` (الافتراضي 4000).
- تجزئة الأسطر الجديدة اختيارية: عيّن `channels.slack.chunkMode="newline"` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل تجزئة الطول.
- يُحدَّد سقف رفع الوسائط بواسطة `channels.slack.mediaMaxMb` (الافتراضي 20).

## تشعيب الردود

افتراضيًا، يرد OpenClaw في القناة الرئيسية. استخدم `channels.slack.replyToMode` للتحكم في التشعيب التلقائي:

| الوضع   | السلوك                                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **الافتراضي.** الرد في القناة الرئيسية. لا يتم التشعيب إلا إذا كانت الرسالة المُحفِّزة أصلًا ضمن خيط.                                          |
| `first` | يذهب الرد الأول إلى الخيط (تحت الرسالة المُحفِّزة)، وتذهب الردود اللاحقة إلى القناة الرئيسية. مفيد للحفاظ على السياق مع تجنب ازدحام الخيوط. |
| `all`   | جميع الردود تذهب إلى الخيط. يُبقي المحادثات محتواة لكنه قد يقلل الظهور.                                                                                        |

ينطبق الوضع على الردود التلقائية واستدعاءات أدوات الوكيل (`slack sendMessage`).

### تشعيب حسب نوع الدردشة

يمكنك تهيئة سلوك تشعيب مختلف لكل نوع دردشة عبر تعيين `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

أنواع الدردشة المدعومة:

- `direct`: رسائل مباشرة 1:1 (Slack `im`)
- `group`: رسائل مباشرة جماعية / MPIMs (Slack `mpim`)
- `channel`: قنوات قياسية (عامة/خاصة)

الأولوية:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. الافتراضي الخاص بالموفّر (`off`)

لا يزال `channels.slack.dm.replyToMode` القديم مقبولًا كبديل احتياطي لـ `direct` عند عدم تعيين تجاوز حسب نوع الدردشة.

أمثلة:

مناقشة DM:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

تشعيب الرسائل المباشرة الجماعية مع إبقاء القنوات في الجذر:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

جعل القنوات بخيوط، مع إبقاء الرسائل المباشرة في الجذر:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### علامات ثلاثية يدوية

للتحكم الدقيق، استخدم هذه الوسوم في ردود الوكيل:

- `[[reply_to_current]]` — الرد على الرسالة المُحفِّزة (بدء/متابعة خيط).
- `[[reply_to:<id>]]` — الرد على مُعرّف رسالة محدد.

## الجلسات + التوجيه

- تشترك الرسائل المباشرة في جلسة `main` (مثل WhatsApp/Telegram).
- تُطابِق القنوات جلسات `agent:<agentId>:slack:channel:<channelId>`.
- تستخدم الأوامر المائلة جلسات `agent:<agentId>:slack:slash:<userId>` (البادئة قابلة للتهيئة عبر `channels.slack.slashCommand.sessionPrefix`).
- إذا لم يوفّر Slack `channel_type`، يستنتجه OpenClaw من بادئة مُعرّف القناة (`D`, `C`, `G`) ويُعيّن افتراضيًا `channel` للحفاظ على ثبات مفاتيح الجلسات.
- يستخدم تسجيل الأوامر الأصلية `commands.native` (الافتراضي العام `"auto"` → Slack مُعطّل) ويمكن تجاوزه لكل مساحة عمل عبر `channels.slack.commands.native`. تتطلب الأوامر النصية رسائل `/...` مستقلة ويمكن تعطيلها باستخدام `commands.text: false`. تُدار الأوامر المائلة في Slack داخل تطبيق Slack ولا تُزال تلقائيًا. استخدم `commands.useAccessGroups: false` لتجاوز فحوص مجموعات الوصول للأوامر.
- قائمة الأوامر الكاملة + التهيئة: [الأوامر المائلة](/tools/slash-commands)

## أمان DM (إقران)

- الافتراضي: `channels.slack.dm.policy="pairing"` — يحصل مُرسلو الرسائل المباشرة غير المعروفين على رمز اقتران (تنتهي صلاحيته بعد ساعة).
- الموافقة عبر: `openclaw pairing approve slack <code>`.
- للسماح للجميع: عيّن `channels.slack.dm.policy="open"` و`channels.slack.dm.allowFrom=["*"]`.
- يقبل `channels.slack.dm.allowFrom` مُعرّفات المستخدمين، أو @handles، أو رسائل البريد الإلكتروني (تُحل عند بدء التشغيل عندما تسمح الرموز). يقبل معالج الإعداد أسماء المستخدمين ويحلّها إلى مُعرّفات أثناء الإعداد عندما تسمح الرموز.

## سياسة المجموعات

- يتحكم `channels.slack.groupPolicy` في التعامل مع القنوات (`open|disabled|allowlist`).
- يتطلب `allowlist` إدراج القنوات في `channels.slack.channels`.
- إذا عيّنت فقط `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` ولم تُنشئ قسم `channels.slack`،
  فإن الإعدادات الافتراضية وقت التشغيل تُعيّن `groupPolicy` إلى `open`. أضف `channels.slack.groupPolicy`،
  أو `channels.defaults.groupPolicy`، أو قائمة سماح للقنوات لإحكام القفل.
- يقبل معالج التهيئة أسماء `#channel` ويحلّها إلى مُعرّفات عند الإمكان
  (عامة + خاصة)؛ وإذا وُجدت تطابقات متعددة، يُفضّل القناة النشطة.
- عند بدء التشغيل، يحل OpenClaw أسماء القنوات/المستخدمين في قوائم السماح إلى مُعرّفات (عندما تسمح الرموز)
  ويسجل الربط؛ وتُبقى الإدخالات غير المحلولة كما كُتبت.
- للسماح **بعدم وجود أي قنوات**، عيّن `channels.slack.groupPolicy: "disabled"` (أو أبقِ قائمة السماح فارغة).

خيارات القناة (`channels.slack.channels.<id>` أو `channels.slack.channels.<name>`):

- `allow`: السماح/المنع للقناة عندما `groupPolicy="allowlist"`.
- `requireMention`: ضبط الإشارة للقناة.
- `tools`: تجاوزات سياسة الأدوات لكل قناة (اختياري) (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: تجاوزات سياسة الأدوات لكل مُرسِل داخل القناة (المفاتيح هي مُعرّفات المُرسِلين/@handles/رسائل البريد الإلكتروني؛ يدعم الرمز الشامل `"*"`).
- `allowBots`: السماح برسائل من تأليف البوت في هذه القناة (الافتراضي: false).
- `users`: قائمة سماح مستخدمين لكل قناة (اختياري).
- `skills`: مُرشّح المهارات (الإغفال = جميع المهارات، الفارغ = لا شيء).
- `systemPrompt`: موجّه نظام إضافي للقناة (يُدمج مع الموضوع/الغرض).
- `enabled`: عيّن `false` لتعطيل القناة.

## أهداف التسليم

استخدم هذه مع الإرسال عبر cron/CLI:

- `user:<id>` للرسائل المباشرة
- `channel:<id>` للقنوات

## إجراءات الأدوات

يمكن تقييد إجراءات أدوات Slack باستخدام `channels.slack.actions.*`:

| مجموعة الإجراءات | الافتراضي | ملاحظات                     |
| ---------------- | --------- | --------------------------- |
| reactions        | مفعّل     | تفاعل + سرد التفاعلات       |
| messages         | مفعّل     | قراءة/إرسال/تعديل/حذف       |
| pins             | مفعّل     | تثبيت/إلغاء التثبيت/القائمة |
| memberInfo       | مفعّل     | معلومات الأعضاء             |
| emojiList        | مفعّل     | قائمة الرموز المخصصة        |

## ملاحظات أمنية

- افتراضيًا، تستخدم الكتابات رمز البوت بحيث تبقى الإجراءات المُغيِّرة للحالة ضمن
  أذونات وهوية بوت التطبيق.
- يتيح تعيين `userTokenReadOnly: false` استخدام رمز المستخدم لعمليات
  الكتابة عند عدم توفر رمز البوت، ما يعني أن الإجراءات تُنفّذ بصلاحيات المستخدم المُثبِّت. تعامل مع رمز المستخدم كرمز عالي الامتيازات وأبقِ بوابات الإجراءات وقوائم السماح مُحكمة.
- إذا فعّلت كتابات رمز المستخدم، فتأكد من أن رمز المستخدم يتضمن نطاقات
  الكتابة المتوقعة (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) وإلا ستفشل تلك العمليات.

## استكشاف الأخطاء وإصلاحها

شغّل هذا التسلسل أولًا:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ثم قم بتأكيد حالة إقران DM إذا لزم الأمر:

```bash
openclaw pairing list slack
```

إخفاقات شائعة:

- متصل لكن لا توجد ردود في القنوات: القناة محظورة بواسطة `groupPolicy` أو غير مدرجة في قائمة السماح `channels.slack.channels`.
- تجاهل الرسائل المباشرة: المُرسِل غير معتمد عندما `channels.slack.dm.policy="pairing"`.
- أخطاء واجهة API (`missing_scope`, `not_in_channel`، فشل المصادقة): رموز البوت/التطبيق أو نطاقات Slack غير مكتملة.

لتدفق الفرز: [/channels/troubleshooting](/channels/troubleshooting).

## ملاحظات

- يتحكم ضبط الإشارة عبر `channels.slack.channels` (عيّن `requireMention` إلى `true`)؛ كما تُحتسب `agents.list[].groupChat.mentionPatterns` (أو `messages.groupChat.mentionPatterns`) كإشارات أيضًا.
- تجاوز تعدد الوكلاء: عيّن أنماطًا لكل وكيل على `agents.list[].groupChat.mentionPatterns`.
- تتبع إشعارات التفاعلات `channels.slack.reactionNotifications` (استخدم `reactionAllowlist` مع الوضع `allowlist`).
- تُتجاهل الرسائل المؤلَّفة بواسطة البوت افتراضيًا؛ فعّل ذلك عبر `channels.slack.allowBots` أو `channels.slack.channels.<id>.allowBots`.
- تحذير: إذا سمحت بالرد على بوتات أخرى (`channels.slack.allowBots=true` أو `channels.slack.channels.<id>.allowBots=true`)، فامنع حلقات ردود بوت-إلى-بوت باستخدام قوائم السماح `requireMention` و`channels.slack.channels.<id>.users`، و/أو أزل الحواجز في `AGENTS.md` و`SOUL.md`.
- لأداة Slack، دلالات إزالة التفاعلات موجودة في [/tools/reactions](/tools/reactions).
- تُنزَّل المرفقات إلى مخزن الوسائط عند السماح وتحت حد الحجم.
