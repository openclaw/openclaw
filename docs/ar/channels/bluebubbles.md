---
summary: "iMessage عبر خادم BlueBubbles على macOS (إرسال/استقبال REST، مؤشرات الكتابة، التفاعلات، الاقتران، إجراءات متقدمة)."
read_when:
  - إعداد قناة BlueBubbles
  - استكشاف أخطاء اقتران webhook وإصلاحها
  - تهيئة iMessage على macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

الحالة: مكوّن إضافي مضمّن يتواصل مع خادم BlueBubbles على macOS عبر HTTP. **موصى به لتكامل iMessage** بفضل واجهة برمجة التطبيقات الأكثر ثراءً وسهولة الإعداد مقارنة بقناة imsg القديمة.

## نظرة عامة

- يعمل على macOS عبر تطبيق BlueBubbles المساعد ([bluebubbles.app](https://bluebubbles.app)).
- مُوصى به/مُختبَر: macOS Sequoia (15). يعمل macOS Tahoe (26)؛ لكن التحرير معطّل حاليًا على Tahoe، وقد تُبلِغ تحديثات أيقونات المجموعات عن نجاح دون المزامنة.
- يتواصل OpenClaw معه عبر واجهة REST الخاصة به (`GET /api/v1/ping`، `POST /message/text`، `POST /chat/:id/*`).
- تصل الرسائل الواردة عبر webhooks؛ بينما تكون الردود الصادرة، ومؤشرات الكتابة، وإيصالات القراءة، وTapbacks مكالمات REST.
- تُستوعَب المرفقات والملصقات كوسائط واردة (وتُعرَض للوكيل عندما يكون ذلك ممكنًا).
- يعمل الاقتران/قائمة السماح بالطريقة نفسها كبقية القنوات (`/channels/pairing` إلخ) باستخدام `channels.bluebubbles.allowFrom` + رموز الاقتران.
- تُعرَض التفاعلات كأحداث نظام تمامًا مثل Slack/Telegram بحيث يمكن للوكلاء «ذكرها» قبل الرد.
- ميزات متقدمة: التحرير، إلغاء الإرسال، سلاسل الردود، تأثيرات الرسائل، إدارة المجموعات.

## البدء السريع

1. ثبّت خادم BlueBubbles على جهاز Mac الخاص بك (اتبع التعليمات على [bluebubbles.app/install](https://bluebubbles.app/install)).

2. في تهيئة BlueBubbles، فعّل واجهة برمجة التطبيقات على الويب وحدّد كلمة مرور.

3. شغّل `openclaw onboard` واختر BlueBubbles، أو هيّئه يدويًا:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. وجّه webhooks الخاصة بـ BlueBubbles إلى Gateway الخاص بك (مثال: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. ابدأ تشغيل Gateway؛ سيُسجِّل معالج webhook ويبدأ الاقتران.

## إبقاء Messages.app نشطًا (بيئات VM / دون واجهة)

قد تنتهي بعض إعدادات macOS داخل آلات افتراضية أو إعدادات دائمة التشغيل إلى دخول Messages.app في حالة «خمول» (تتوقف الأحداث الواردة حتى فتح التطبيق/إحضاره للمقدمة). حل بسيط هو **تنبيه Messages كل 5 دقائق** باستخدام AppleScript + LaunchAgent.

### 1. حفظ AppleScript

احفظ هذا باسم:

- `~/Scripts/poke-messages.scpt`

مثال على سكربت (غير تفاعلي؛ لا يسرق التركيز):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. تثبيت LaunchAgent

احفظ هذا باسم:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

ملاحظات:

- يعمل هذا **كل 300 ثانية** و**عند تسجيل الدخول**.
- قد يؤدي التشغيل الأول إلى ظهور مطالبات **Automation** في macOS (`osascript` → Messages). وافق عليها ضمن جلسة المستخدم نفسها التي تُشغِّل LaunchAgent.

تحميله:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

يتوفر BlueBubbles في معالج الإعداد التفاعلي:

```
openclaw onboard
```

يطالب المعالج بـ:

- **Server URL** (إلزامي): عنوان خادم BlueBubbles (مثل: `http://192.168.1.100:1234`)
- **Password** (إلزامي): كلمة مرور واجهة برمجة التطبيقات من إعدادات خادم BlueBubbles
- **Webhook path** (اختياري): الافتراضي هو `/bluebubbles-webhook`
- **سياسة الرسائل الخاصة (DM)**: اقتران، قائمة سماح، مفتوح، أو معطّل
- **قائمة السماح**: أرقام الهواتف، البريد الإلكتروني، أو أهداف الدردشة

يمكنك أيضًا إضافة BlueBubbles عبر CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## التحكم بالوصول (الرسائل الخاصة + المجموعات)

DMs:

- الافتراضي: `channels.bluebubbles.dmPolicy = "pairing"`.
- يتلقى المرسلون غير المعروفين رمز اقتران؛ وتُتجاهل الرسائل حتى الموافقة (تنتهي صلاحية الرموز بعد ساعة واحدة).
- الموافقة عبر:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- الاقتران هو تبادل الرموز الافتراضي. التفاصيل: [Pairing](/channels/pairing)

المجموعات:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (الافتراضي: `allowlist`).
- يتحكم `channels.bluebubbles.groupAllowFrom` بمن يمكنه التحفيز داخل المجموعات عندما يكون `allowlist` مُعيّنًا.

### ذكر بوابة (مجموعات)

يدعم BlueBubbles تقييد الذِكر لدردشات المجموعات، بما يطابق سلوك iMessage/WhatsApp:

- يستخدم `agents.list[].groupChat.mentionPatterns` (أو `messages.groupChat.mentionPatterns`) لاكتشاف الذِكر.
- عند تمكين `requireMention` لمجموعة ما، لا يرد الوكيل إلا عند ذِكره.
- تتجاوز أوامر التحكم من المرسلين المصرّح لهم تقييد الذِكر.

تهيئة لكل مجموعة:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### تقييد الأوامر

- تتطلب أوامر التحكم (مثل `/config`، `/model`) تفويضًا.
- يستخدم `allowFrom` و`groupAllowFrom` لتحديد تفويض الأوامر.
- يمكن للمرسلين المصرّح لهم تشغيل أوامر التحكم حتى دون الذِكر داخل المجموعات.

## مؤشرات الكتابة + إيصالات القراءة

- **مؤشرات الكتابة**: تُرسَل تلقائيًا قبل وأثناء توليد الرد.
- **إيصالات القراءة**: يتحكم بها `channels.bluebubbles.sendReadReceipts` (الافتراضي: `true`).
- **مؤشرات الكتابة**: يرسل OpenClaw أحداث بدء الكتابة؛ ويقوم BlueBubbles بمسح حالة الكتابة تلقائيًا عند الإرسال أو انتهاء المهلة (إيقافها يدويًا عبر DELETE غير موثوق).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## إجراءات متقدمة

يدعم BlueBubbles إجراءات رسائل متقدمة عند تمكينها في التهيئة:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

الإجراءات المتاحة:

- **react**: إضافة/إزالة تفاعلات Tapback (`messageId`، `emoji`، `remove`)
- **edit**: تحرير رسالة مُرسلة (`messageId`، `text`)
- **unsend**: إلغاء إرسال رسالة (`messageId`)
- **reply**: الرد على رسالة محددة (`messageId`، `text`، `to`)
- **sendWithEffect**: الإرسال مع تأثير iMessage (`text`، `to`، `effectId`)
- **renameGroup**: إعادة تسمية دردشة جماعية (`chatGuid`، `displayName`)
- **setGroupIcon**: تعيين أيقونة/صورة لدردشة جماعية (`chatGuid`، `media`) — غير مستقر على macOS 26 Tahoe (قد تُعيد الواجهة نجاحًا دون مزامنة الأيقونة).
- **addParticipant**: إضافة شخص إلى مجموعة (`chatGuid`، `address`)
- **removeParticipant**: إزالة شخص من مجموعة (`chatGuid`، `address`)
- **leaveGroup**: مغادرة دردشة جماعية (`chatGuid`)
- **sendAttachment**: إرسال وسائط/ملفات (`to`، `buffer`، `filename`، `asVoice`)
  - المذكرات الصوتية: عيّن `asVoice: true` مع صوت **MP3** أو **CAF** للإرسال كرسالة صوتية في iMessage. يقوم BlueBubbles بتحويل MP3 → CAF عند إرسال المذكرات الصوتية.

### معرفات الرسالة (قصيرة مقابل كاملة)

قد يعرض OpenClaw معرّفات رسائل _قصيرة_ (مثل `1`، `2`) لتقليل استهلاك الرموز.

- يمكن أن تكون `MessageSid` / `ReplyToId` معرّفات قصيرة.
- تحتوي `MessageSidFull` / `ReplyToIdFull` على المعرّفات الكاملة لدى الموفّر.
- المعرّفات القصيرة في الذاكرة فقط؛ وقد تنتهي صلاحيتها عند إعادة التشغيل أو إخلاء الذاكرة المؤقتة.
- تقبل الإجراءات `messageId` القصير أو الكامل، لكن المعرّفات القصيرة ستفشل إذا لم تعد متاحة.

استخدم المعرّفات الكاملة للأتمتة والتخزين الدائمين:

- القوالب: `{{MessageSidFull}}`، `{{ReplyToIdFull}}`
- السياق: `MessageSidFull` / `ReplyToIdFull` في الحمولات الواردة

راجع [Configuration](/gateway/configuration) لمتغيرات القوالب.

## بثّ الكتل

تحكّم فيما إذا كانت الردود تُرسَل كرسالة واحدة أو تُبث على شكل كتل:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## الوسائط + الحدود

- تُنزَّل المرفقات الواردة وتُخزَّن في ذاكرة تخزين الوسائط.
- حدّ الوسائط عبر `channels.bluebubbles.mediaMaxMb` (الافتراضي: 8 ميغابايت).
- يُجزَّأ النص الصادر إلى `channels.bluebubbles.textChunkLimit` (الافتراضي: 4000 حرف).

## مرجع التهيئة

التهيئة الكاملة: [Configuration](/gateway/configuration)

خيارات الموفّر:

- `channels.bluebubbles.enabled`: تمكين/تعطيل القناة.
- `channels.bluebubbles.serverUrl`: عنوان الأساس لواجهة REST الخاصة بـ BlueBubbles.
- `channels.bluebubbles.password`: كلمة مرور واجهة برمجة التطبيقات.
- `channels.bluebubbles.webhookPath`: مسار نقطة نهاية webhook (الافتراضي: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (الافتراضي: `pairing`).
- `channels.bluebubbles.allowFrom`: قائمة السماح للرسائل الخاصة (المعرّفات، عناوين البريد، أرقام E.164، `chat_id:*`، `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (الافتراضي: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: قائمة سماح مرسلي المجموعات.
- `channels.bluebubbles.groups`: تهيئة لكل مجموعة (`requireMention`، إلخ).
- `channels.bluebubbles.sendReadReceipts`: إرسال إيصالات القراءة (الافتراضي: `true`).
- `channels.bluebubbles.blockStreaming`: تمكين بثّ الكتل (الافتراضي: `false`؛ مطلوب للبث).
- `channels.bluebubbles.textChunkLimit`: حجم تجزئة الإرسال بالأحرف (الافتراضي: 4000).
- `channels.bluebubbles.chunkMode`: `length` (الافتراضي) يجزّئ فقط عند تجاوز `textChunkLimit`؛ بينما `newline` يجزّئ عند الأسطر الفارغة (حدود الفقرات) قبل التجزئة حسب الطول.
- `channels.bluebubbles.mediaMaxMb`: حدّ الوسائط الواردة بالميغابايت (الافتراضي: 8).
- `channels.bluebubbles.historyLimit`: الحد الأقصى لرسائل المجموعات للسياق (0 لتعطيله).
- `channels.bluebubbles.dmHistoryLimit`: حدّ سجل الرسائل الخاصة.
- `channels.bluebubbles.actions`: تمكين/تعطيل إجراءات محددة.
- `channels.bluebubbles.accounts`: تهيئة الحسابات المتعددة.

خيارات عامة ذات صلة:

- `agents.list[].groupChat.mentionPatterns` (أو `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## العنونة / أهداف التسليم

يُفضَّل `chat_guid` للتوجيه المستقر:

- `chat_guid:iMessage;-;+15555550123` (مفضّل للمجموعات)
- `chat_id:123`
- `chat_identifier:...`
- المعرّفات المباشرة: `+15555550123`، `user@example.com`
  - إذا لم يكن للمعرّف المباشر دردشة خاصة قائمة، فسيُنشئ OpenClaw واحدة عبر `POST /api/v1/chat/new`. يتطلب ذلك تمكين واجهة BlueBubbles الخاصة.

## الأمان

- تُصادَق طلبات webhook بمقارنة معلمات الاستعلام أو الرؤوس `guid`/`password` مع `channels.bluebubbles.password`. كما تُقبَل الطلبات من `localhost`.
- احفظ كلمة مرور واجهة برمجة التطبيقات ونقطة نهاية webhook بسرية (عامِلْهما كبيانات اعتماد).
- تعني ثقة localhost أن وكيلًا عكسيًا على المضيف نفسه قد يتجاوز كلمة المرور دون قصد. إذا قمت بتمرير Gateway عبر وكيل، فاطلب المصادقة على الوكيل واضبط `gateway.trustedProxies`. راجع [Gateway security](/gateway/security#reverse-proxy-configuration).
- فعّل HTTPS وقواعد الجدار الناري على خادم BlueBubbles إذا كنت تعرضه خارج شبكتك المحلية.

## استكشاف الأخطاء وإصلاحها

- إذا توقفت أحداث الكتابة/القراءة عن العمل، فتحقق من سجلات webhook في BlueBubbles وتأكد من أن مسار Gateway يطابق `channels.bluebubbles.webhookPath`.
- تنتهي صلاحية رموز الاقتران بعد ساعة واحدة؛ استخدم `openclaw pairing list bluebubbles` و`openclaw pairing approve bluebubbles <code>`.
- تتطلب التفاعلات واجهة BlueBubbles الخاصة (`POST /api/v1/message/react`)؛ تأكد من أن إصدار الخادم يوفّرها.
- يتطلب التحرير/إلغاء الإرسال macOS 13+ وإصدار خادم BlueBubbles متوافقًا. على macOS 26 (Tahoe)، التحرير معطّل حاليًا بسبب تغييرات الواجهة الخاصة.
- قد تكون تحديثات أيقونات المجموعات غير مستقرة على macOS 26 (Tahoe): قد تُعيد الواجهة نجاحًا دون مزامنة الأيقونة الجديدة.
- يُخفي OpenClaw تلقائيًا الإجراءات المعروفة بأنها معطّلة استنادًا إلى إصدار macOS لخادم BlueBubbles. إذا ظلّ التحرير ظاهرًا على macOS 26 (Tahoe)، عطّله يدويًا باستخدام `channels.bluebubbles.actions.edit=false`.
- لمعلومات الحالة/الصحة: `openclaw status --all` أو `openclaw status --deep`.

للمرجع العام لسير عمل القنوات، راجع [Channels](/channels) ودليل [Plugins](/tools/plugin).
