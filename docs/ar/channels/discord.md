---
summary: "حالة دعم بوت Discord، والقدرات، والتهيئة"
read_when:
  - العمل على ميزات قناة Discord
title: "Discord"
---

# Discord (Bot API)

الحالة: جاهز للرسائل المباشرة (DM) وقنوات نصّ الخوادم (guild) عبر بوابة بوت Discord الرسمية.

## إعداد سريع (للمبتدئين)

1. أنشئ بوت Discord وانسخ رمز البوت (bot token).
2. في إعدادات تطبيق Discord، فعّل **Message Content Intent** (و **Server Members Intent** إذا كنت تخطط لاستخدام قوائم السماح أو البحث عن الأسماء).
3. عيّن الرمز المميّز لـ OpenClaw:
   - متغير البيئة: `DISCORD_BOT_TOKEN=...`
   - أو في التهيئة: `channels.discord.token: "..."`.
   - إذا تم تعيينهما معًا، تكون أولوية التهيئة أعلى (الرجوع إلى متغير البيئة يكون فقط للحساب الافتراضي).
4. ادعُ البوت إلى خادمك مع أذونات الرسائل (أنشئ خادمًا خاصًا إذا كنت تريد الرسائل المباشرة فقط).
5. شغّل الـ Gateway.
6. الوصول عبر الرسائل المباشرة يكون بالاقتران افتراضيًا؛ وافق على رمز الاقتران عند أول تواصل.

الحد الأدنى للتهيئة:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## الأهداف

- التحدث إلى OpenClaw عبر الرسائل المباشرة في Discord أو قنوات الخوادم.
- المحادثات المباشرة تُدمج في الجلسة الرئيسية للوكيل (الافتراضي `agent:main:main`)؛ بينما تبقى قنوات الخوادم معزولة كـ `agent:<agentId>:discord:channel:<channelId>` (تستخدم أسماء العرض `discord:<guildSlug>#<channelSlug>`).
- تُتجاهل الرسائل المباشرة الجماعية افتراضيًا؛ يمكن تمكينها عبر `channels.discord.dm.groupEnabled` وتقييدها اختياريًا عبر `channels.discord.dm.groupChannels`.
- الحفاظ على توجيه حتمي: الردود تعود دائمًا إلى القناة التي وصلت منها.

## كيف يعمل

1. أنشئ تطبيق Discord → Bot، وفعّل المقاصد التي تحتاجها (الرسائل المباشرة + رسائل الخوادم + محتوى الرسائل)، ثم انسخ رمز البوت.
2. ادعُ البوت إلى خادمك مع الأذونات اللازمة لقراءة/إرسال الرسائل حيث تريد استخدامه.
3. هيّئ OpenClaw باستخدام `channels.discord.token` (أو `DISCORD_BOT_TOKEN` كخيار احتياطي).
4. شغّل الـ Gateway؛ سيبدأ قناة Discord تلقائيًا عند توفر الرمز (الأولوية للتهيئة ثم متغير البيئة) وعندما لا يكون `channels.discord.enabled` هو `false`.
   - إذا فضّلت متغيرات البيئة، عيّن `DISCORD_BOT_TOKEN` (كتلة التهيئة اختيارية).
5. المحادثات المباشرة: استخدم `user:<id>` (أو إشارة `<@id>`) عند التسليم؛ جميع الأدوار تُسجَّل في جلسة `main` المشتركة. المعرفات الرقمية المجردة ملتبسة ومرفوضة.
6. قنوات الخوادم: استخدم `channel:<channelId>` للتسليم. الإشارات مطلوبة افتراضيًا ويمكن تعيينها لكل خادم أو لكل قناة.
7. المحادثات المباشرة: آمنة افتراضيًا عبر `channels.discord.dm.policy` (الافتراضي: `"pairing"`). يحصل المرسلون غير المعروفين على رمز اقتران (ينتهي بعد ساعة)؛ وافق عبر `openclaw pairing approve discord <code>`.
   - للحفاظ على السلوك القديم «مفتوح للجميع»: عيّن `channels.discord.dm.policy="open"` و `channels.discord.dm.allowFrom=["*"]`.
   - لقائمة سماح صارمة: عيّن `channels.discord.dm.policy="allowlist"` وأدرج المرسلين في `channels.discord.dm.allowFrom`.
   - لتجاهل جميع الرسائل المباشرة: عيّن `channels.discord.dm.enabled=false` أو `channels.discord.dm.policy="disabled"`.
8. الرسائل المباشرة الجماعية تُتجاهل افتراضيًا؛ فعّلها عبر `channels.discord.dm.groupEnabled` وقيّدها اختياريًا عبر `channels.discord.dm.groupChannels`.
9. قواعد الخوادم الاختيارية: عيّن `channels.discord.guilds` باستخدام معرّف الخادم (المفضّل) أو الاسم المختصر، مع قواعد لكل قناة.
10. الأوامر الأصلية الاختيارية: القيمة الافتراضية لـ `commands.native` هي `"auto"` (مفعّل لـ Discord/Telegram، ومعطّل لـ Slack). يمكن التجاوز عبر `channels.discord.commands.native: true|false|"auto"`؛ ويقوم `false` بمسح الأوامر المسجّلة سابقًا. تتحكم `commands.text` في الأوامر النصية ويجب إرسالها كرسائل مستقلة `/...`. استخدم `commands.useAccessGroups: false` لتجاوز فحوصات مجموعات الوصول للأوامر.
    - قائمة الأوامر الكاملة + التهيئة: [Slash commands](/tools/slash-commands)
11. سجل سياق الخادم الاختياري: عيّن `channels.discord.historyLimit` (الافتراضي 20، ويرجع إلى `messages.groupChat.historyLimit`) لتضمين آخر N رسائل خادم كسياق عند الرد على إشارة. عيّن `0` لتعطيله.
12. التفاعلات: يمكن للوكيل إطلاق التفاعلات عبر أداة `discord` (مقيّدة بواسطة `channels.discord.actions.*`).
    - دلالات إزالة التفاعلات: انظر [/tools/reactions](/tools/reactions).
    - لا تُعرَض أداة `discord` إلا عندما تكون القناة الحالية Discord.
13. تستخدم الأوامر الأصلية مفاتيح جلسات معزولة (`agent:<agentId>:discord:slash:<userId>`) بدل الجلسة المشتركة `main`.

ملاحظة: يعتمد حلّ الاسم → المعرّف على بحث أعضاء الخادم ويتطلب Server Members Intent؛ إذا تعذّر على البوت البحث عن الأعضاء، استخدم المعرّفات أو إشارات `<@id>`.
ملاحظة: الأسماء المختصرة تكون بحروف صغيرة مع استبدال المسافات بـ `-`. تُختصر أسماء القنوات دون البادئة `#`.
ملاحظة: تتضمن أسطر سياق الخادم `[from:]` كلاً من `author.tag` + `id` لتسهيل الردود الجاهزة للإشارة.

## كتابات التهيئة

افتراضيًا، يُسمح لـ Discord بكتابة تحديثات التهيئة التي يطلقها `/config set|unset` (يتطلب `commands.config: true`).

للتعطيل:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## كيفية إنشاء بوتك الخاص

هذا إعداد «Discord Developer Portal» لتشغيل OpenClaw في قناة خادم (guild) مثل `#help`.

### 1. إنشاء تطبيق Discord + مستخدم البوت

1. Discord Developer Portal → **Applications** → **New Application**
2. داخل تطبيقك:
   - **Bot** → **Add Bot**
   - انسخ **Bot Token** (وهو ما تضعه في `DISCORD_BOT_TOKEN`)

### 2) تمكين مقاصد البوابة التي يحتاجها OpenClaw

تحظر Discord «المقاصد المميّزة» ما لم تُمكَّن صراحةً.

في **Bot** → **Privileged Gateway Intents**، فعّل:

- **Message Content Intent** (مطلوب لقراءة نص الرسائل في معظم الخوادم؛ بدونه سترى «Used disallowed intents» أو سيتصل البوت دون أن يتفاعل مع الرسائل)
- **Server Members Intent** (موصى به؛ مطلوب لبعض عمليات البحث عن الأعضاء/المستخدمين ومطابقة قوائم السماح في الخوادم)

عادةً **لا** تحتاج إلى **Presence Intent**. تعيين حالة حضور البوت نفسه (إجراء `setPresence`) يستخدم OP3 للبوابة ولا يتطلب هذا المقصد؛ يلزم فقط إذا أردت تلقي تحديثات الحضور لأعضاء خادم آخرين.

### 3. إنشاء رابط دعوة (مولّد OAuth2)

في تطبيقك: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (مطلوب للأوامر الأصلية)

**أذونات البوت** (الحد الأدنى)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (اختياري لكنه موصى به)
- ✅ Use External Emojis / Stickers (اختياري؛ فقط إذا رغبت بها)

تجنب **Administrator** إلا إذا كنت تصحّح الأخطاء وتثق بالبوت تمامًا.

انسخ الرابط المُنشأ، وافتحه، واختر خادمك، وثبّت البوت.

### 4. الحصول على المعرّفات (الخادم/المستخدم/القناة)

تستخدم Discord معرّفات رقمية في كل مكان؛ وتفضّل تهيئة OpenClaw المعرّفات.

1. Discord (سطح المكتب/الويب) → **User Settings** → **Advanced** → فعّل **Developer Mode**
2. انقر بزر الفأرة الأيمن:
   - اسم الخادم → **Copy Server ID** (معرّف الخادم)
   - القناة (مثل `#help`) → **Copy Channel ID**
   - المستخدم الخاص بك → **Copy User ID**

### 5) تهيئة OpenClaw

#### الرمز

تعيين رمز البوت عن طريق var (موصى به على الخوادم):

- `DISCORD_BOT_TOKEN=...`

أو عبر التهيئة:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

دعم تعدد الحسابات: استخدم `channels.discord.accounts` مع رموز لكل حساب و `name` اختياريًا. انظر [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) للنمط المشترك.

#### قائمة السماح + توجيه القنوات

مثال «خادم واحد، السماح لي فقط، السماح لقناة #help فقط»:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

ملاحظات:

- تعني `requireMention: true` أن البوت يرد فقط عند الإشارة إليه (موصى به للقنوات المشتركة).
- تُعد `agents.list[].groupChat.mentionPatterns` (أو `messages.groupChat.mentionPatterns`) أيضًا إشارات لرسائل الخوادم.
- تجاوز متعدد الوكلاء: عيّن أنماطًا لكل وكيل على `agents.list[].groupChat.mentionPatterns`.
- إذا وُجد `channels`، تُرفَض أي قناة غير مُدرجة افتراضيًا.
- استخدم إدخال قناة `"*"` لتطبيق الإعدادات الافتراضية عبر جميع القنوات؛ وتغلّب الإدخالات الصريحة على الرمز العام.
- ترث المواضيع (threads) إعدادات القناة الأم (قائمة السماح، `requireMention`، المهارات، المطالبات، إلخ) ما لم تُضِف معرّف قناة الموضوع صراحةً. إلا إذا قمت بإضافة معرف قناة الموضوع صراحة.
- تلميح المالك: عندما تطابق قائمة سماح `users` على مستوى الخادم أو القناة المرسل، يعامل OpenClaw هذا المرسل كمالك في مطالبة النظام. لمالك عام عبر القنوات، عيّن `commands.ownerAllowFrom`.
- تُتجاهل رسائل البوت افتراضيًا؛ عيّن `channels.discord.allowBots=true` للسماح بها (تبقى رسائل البوت نفسه مُصفّاة).
- تحذير: إذا سمحت بالرد على بوتات أخرى (`channels.discord.allowBots=true`)، فامنع حلقات الرد بين البوتات عبر قوائم السماح `requireMention` و `channels.discord.guilds.*.channels.<id>.users`، و/أو إزالة الحواجز في `AGENTS.md` و `SOUL.md`.

### 6. التحقق من العمل

1. شغّل الـ Gateway.
2. في قناة الخادم، أرسل: `@Krill hello` (أو أي اسم بوتك).
3. إذا لم يحدث شيء: تحقّق من **استكشاف الأخطاء وإصلاحها** أدناه.

### استكشاف الأخطاء وإصلاحها

- أولًا: شغّل `openclaw doctor` و `openclaw channels status --probe` (تحذيرات قابلة للتنفيذ + تدقيقات سريعة).
- **«Used disallowed intents»**: فعّل **Message Content Intent** (وربما **Server Members Intent**) في بوابة المطوّرين، ثم أعد تشغيل الـ Gateway.
- **يتصل البوت لكنه لا يرد أبدًا في قناة خادم**:
  - نقص **Message Content Intent**، أو
  - يفتقر البوت لأذونات القناة (View/Send/Read History)، أو
  - يتطلب إعدادك ذكر ولم تذكر ذلك، أو
  - قائمة السماح للخادم/القناة ترفض القناة/المستخدم.
- **`requireMention: false` لكن لا تزال بلا ردود**:
- القيمة الافتراضية لـ `channels.discord.groupPolicy` هي **allowlist**؛ عيّنها إلى `"open"` أو أضِف إدخال خادم تحت `channels.discord.guilds` (واختياريًا أدرج القنوات تحت `channels.discord.guilds.<id>.channels` للتقييد).
  - إذا عيّنت فقط `DISCORD_BOT_TOKEN` ولم تُنشئ قسم `channels.discord`، فإن وقت التشغيل
    يعيّن `groupPolicy` افتراضيًا إلى `open`. أضِف `channels.discord.groupPolicy`،
    `channels.defaults.groupPolicy`، أو قائمة سماح خادم/قناة لتقييده.
- يجب أن يكون `requireMention` تحت `channels.discord.guilds` (أو قناة محددة). تجاهَل `channels.discord.requireMention` على المستوى الأعلى.
- **تدقيق الأذونات** (`channels status --probe`) يتحقق فقط من معرّفات القنوات الرقمية. إذا استخدمت أسماء مختصرة/أسماء كـ مفاتيح `channels.discord.guilds.*.channels`، فلا يمكن للتدقيق التحقق من الأذونات.
- **الرسائل المباشرة لا تعمل**: `channels.discord.dm.enabled=false`، أو `channels.discord.dm.policy="disabled"`، أو لم تتم الموافقة عليك بعد (`channels.discord.dm.policy="pairing"`).
- **موافقات التنفيذ في Discord**: يدعم Discord **واجهة أزرار** لموافقات التنفيذ في الرسائل المباشرة (السماح مرة / السماح دائمًا / الرفض). إن `/approve <id> ...` مخصص فقط للموافقات المُعاد توجيهها ولن يحل مطالبات الأزرار في Discord. إذا رأيت `❌ Failed to submit approval: Error: unknown approval id` أو لم تظهر الواجهة، فتحقق من:
  - `channels.discord.execApprovals.enabled: true` في تهيئتك.
  - إدراج معرّف مستخدم Discord الخاص بك في `channels.discord.execApprovals.approvers` (تُرسَل الواجهة فقط للموافقين).
  - استخدام الأزرار في رسالة DM (**Allow once**، **Always allow**، **Deny**).
  - راجع [Exec approvals](/tools/exec-approvals) و [Slash commands](/tools/slash-commands) لتدفق الموافقات والأوامر الأوسع.

## القدرات والحدود

- الرسائل المباشرة وقنوات النص في الخوادم (تُعامل المواضيع كقنوات منفصلة؛ الصوت غير مدعوم).
- تُرسل مؤشرات الكتابة بأفضل جهد؛ ويستخدم تقسيم الرسائل `channels.discord.textChunkLimit` (الافتراضي 2000) ويقسّم الردود الطويلة حسب عدد الأسطر (`channels.discord.maxLinesPerMessage`، الافتراضي 17).
- تقسيم اختياري حسب الأسطر الجديدة: عيّن `channels.discord.chunkMode="newline"` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التقسيم حسب الطول.
- دعم رفع الملفات حتى الحد المهيّأ `channels.discord.mediaMaxMb` (الافتراضي 8 ميغابايت).
- ردود الخوادم مقيّدة بالإشارة افتراضيًا لتجنب الضوضاء.
- يُحقن سياق الرد عند الإشارة إلى رسالة أخرى (المحتوى المقتبس + المعرّفات).
- ترابط الردود الأصلي **معطّل افتراضيًا**؛ فعّله عبر `channels.discord.replyToMode` وعلامات الرد.

## سياسة إعادة المحاولة

تعيد مكالمات Discord API الصادرة المحاولة عند حدود المعدل (429) باستخدام `retry_after` الخاص بـ Discord عندما يتوفر، مع تراجع أُسّي وتذبذب. تُهيّأ عبر `channels.discord.retry`. انظر [Retry policy](/concepts/retry).

## التهيئة

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

تُتحكَّم تفاعلات الإقرار (Ack) عالميًا عبر `messages.ackReaction` +
`messages.ackReactionScope`. استخدم `messages.removeAckAfterReply` لمسح
تفاعل الإقرار بعد رد البوت.

- `dm.enabled`: عيّن `false` لتجاهل جميع الرسائل المباشرة (الافتراضي `true`).
- `dm.policy`: التحكم في وصول الرسائل المباشرة (`pairing` موصى به). يتطلب `"open"` وجود `dm.allowFrom=["*"]`.
- `dm.allowFrom`: قائمة سماح الرسائل المباشرة (معرّفات المستخدمين أو الأسماء). تُستخدم بواسطة `dm.policy="allowlist"` وللتحقق `dm.policy="open"`. يقبل المعالج أسماء المستخدمين ويحلّها إلى معرّفات عندما يستطيع البوت البحث عن الأعضاء.
- `dm.groupEnabled`: تمكين الرسائل المباشرة الجماعية (الافتراضي `false`).
- `dm.groupChannels`: قائمة سماح اختيارية لمعرّفات/أسماء مختصرة لقنوات الرسائل المباشرة الجماعية.
- `groupPolicy`: يتحكم في التعامل مع قنوات الخوادم (`open|disabled|allowlist`)؛ يتطلب `allowlist` قوائم سماح للقنوات.
- `guilds`: قواعد لكل خادم بمفتاح معرّف الخادم (المفضّل) أو الاسم المختصر.
- `guilds."*"`: إعدادات افتراضية لكل خادم تُطبَّق عند عدم وجود إدخال صريح.
- `guilds.<id>.slug`: اسم مختصر ودّي اختياري يُستخدم لأسماء العرض.
- `guilds.<id>.users`: قائمة سماح اختيارية لمستخدمي الخادم (معرّفات أو أسماء).
- `guilds.<id>.tools`: تجاوزات سياسة الأدوات على مستوى الخادم (`allow`/`deny`/`alsoAllow`) تُستخدم عند غياب تجاوز القناة.
- `guilds.<id>.toolsBySender`: تجاوزات سياسة الأدوات لكل مُرسِل على مستوى الخادم (تُطبَّق عند غياب تجاوز القناة؛ يدعم الرمز العام `"*"`).
- `guilds.<id>.channels.<channel>.allow`: السماح/المنع للقناة عندما `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: تقييد الإشارة للقناة.
- `guilds.<id>.channels.<channel>.tools`: تجاوزات سياسة الأدوات لكل قناة (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: تجاوزات سياسة الأدوات لكل مُرسِل داخل القناة (يدعم الرمز العام `"*"`).
- `guilds.<id>.channels.<channel>.users`: قائمة سماح مستخدمين اختيارية لكل قناة.
- `guilds.<id>.channels.<channel>.skills`: مُرشّح المهارات (الحذف = كل المهارات، الفارغ = لا شيء).
- `guilds.<id>.channels.<channel>.systemPrompt`: مطالبة نظام إضافية للقناة. تُحقن مواضيع قنوات Discord كسياق **غير موثوق** (ليس مطالبة نظام).
- `guilds.<id>.channels.<channel>.enabled`: عيّن `false` لتعطيل القناة.
- `guilds.<id>.channels`: قواعد القنوات (المفاتيح هي الأسماء المختصرة أو المعرّفات).
- `guilds.<id>.requireMention`: متطلب الإشارة على مستوى الخادم (قابل للتجاوز لكل قناة).
- `guilds.<id>.reactionNotifications`: وضع أحداث نظام التفاعلات (`off`، `own`، `all`، `allowlist`).
- `textChunkLimit`: حجم تجزئة النص الصادر (محارف). الافتراضي: 2000.
- `chunkMode`: يقوم `length` (الافتراضي) بالتقسيم فقط عند تجاوز `textChunkLimit`؛ بينما يقوم `newline` بالتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التقسيم حسب الطول.
- `maxLinesPerMessage`: الحد الأقصى المرن لعدد الأسطر لكل رسالة. الافتراضي: 17.
- `mediaMaxMb`: تقييد الوسائط الواردة المحفوظة على القرص.
- `historyLimit`: عدد رسائل الخادم الأخيرة المُضمَّنة كسياق عند الرد على إشارة (الافتراضي 20؛ يرجع إلى `messages.groupChat.historyLimit`؛ يُعطَّل عبر `0`).
- `dmHistoryLimit`: حد سجل الرسائل المباشرة بوحدات أدوار المستخدم. تجاوزات لكل مستخدم: `dms["<user_id>"].historyLimit`.
- `retry`: سياسة إعادة المحاولة لمكالمات Discord API الصادرة (المحاولات، minDelayMs، maxDelayMs، jitter).
- `pluralkit`: حل رسائل PluralKit المُفوَّضة بحيث تظهر أعضاء النظام كمرسلين مميّزين.
- `actions`: بوابات الأدوات لكل إجراء؛ الحذف للسماح بالجميع (عيّن `false` للتعطيل).
  - `reactions` (يشمل react + قراءة التفاعلات)
  - `stickers`، `emojiUploads`، `stickerUploads`، `polls`، `permissions`، `messages`، `threads`، `pins`، `search`
  - `memberInfo`، `roleInfo`، `channelInfo`، `voiceStatus`، `events`
  - `channels` (إنشاء/تحرير/حذف القنوات + الفئات + الأذونات)
  - `roles` (إضافة/إزالة الأدوار، الافتراضي `false`)
  - `moderation` (إسكات/طرد/حظر، الافتراضي `false`)
  - `presence` (حالة/نشاط البوت، الافتراضي `false`)
- `execApprovals`: موافقات تنفيذ خاصة بـ Discord عبر الرسائل المباشرة (واجهة أزرار). يدعم `enabled`، `approvers`، `agentFilter`، `sessionFilter`.

تستخدم إشعارات التفاعلات `guilds.<id>.reactionNotifications`:

- `off`: بلا أحداث تفاعل.
- `own`: التفاعلات على رسائل البوت نفسه (الافتراضي).
- `all`: كل التفاعلات على جميع الرسائل.
- `allowlist`: التفاعلات من `guilds.<id>.users` على جميع الرسائل (قائمة فارغة تعطل).

### دعم PluralKit (PK)

فعّل عمليات بحث PK بحيث تُحل الرسائل المُفوَّضة إلى النظام + العضو الأساسي.
عند التمكين، يستخدم OpenClaw هوية العضو لقوائم السماح ويُسمّي
المرسل `Member (PK:System)` لتجنب الإشارات غير المقصودة في Discord.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

ملاحظات قائمة السماح (عند تمكين PK):

- استخدم `pk:<memberId>` في `dm.allowFrom`، `guilds.<id>.users`، أو `users` لكل قناة.
- تُطابق أسماء العرض للأعضاء أيضًا بالاسم/الاسم المختصر.
- تستخدم عمليات البحث **معرّف رسالة Discord الأصلي** (قبل التفويض)، لذا لا يحل API الخاص بـ PK إلا ضمن نافذة 30 دقيقة.
- إذا فشلت عمليات بحث PK (مثل نظام خاص دون رمز)، تُعامل الرسائل المُفوَّضة كرسائل بوت وتُسقَط ما لم يكن `channels.discord.allowBots=true`.

### القيم الافتراضية لإجراءات الأدوات

| مجموعة الإجراءات | الافتراضي | الملاحظات                                          |
| ---------------- | --------- | -------------------------------------------------- |
| reactions        | مفعّل     | التفاعل + سرد التفاعلات + emojiList                |
| stickers         | مفعّل     | إرسال الملصقات                                     |
| emojiUploads     | مفعّل     | تحميل الرموز التعبيرية                             |
| stickerUploads   | مفعّل     | رفع الملصقات                                       |
| polls            | مفعّل     | إنشاء استطلاعات                                    |
| permissions      | مفعّل     | لقطة أذونات القناة                                 |
| messages         | مفعّل     | قراءة/إرسال/تحرير/حذف                              |
| threads          | مفعّل     | إنشاء/سرد/رد                                       |
| pins             | مفعّل     | تثبيت/إلغاء التثبيت/القائمة                        |
| search           | مفعّل     | البحث في الرسائل (ميزة تجريبية) |
| memberInfo       | مفعّل     | معلومات الأعضاء                                    |
| roleInfo         | مفعّل     | قائمة الأدوار                                      |
| channelInfo      | مفعّل     | معلومات القناة + السرد                             |
| channels         | مفعّل     | إدارة القنوات/الفئات                               |
| voiceStatus      | مفعّل     | الاستعلام عن حالة الصوت                            |
| events           | مفعّل     | سرد/إنشاء أحداث مجدولة                             |
| roles            | معطل      | إضافة/إزالة الأدوار                                |
| moderation       | معطل      | إسكات/طرد/حظر                                      |
| presence         | معطل      | حالة/نشاط البوت (setPresence)   |

- `replyToMode`: `off` (الافتراضي)، `first`، أو `all`. يُطبَّق فقط عندما يتضمن النموذج وسم رد.

## وسوم الرد

لطلب رد مترابط، يمكن للنموذج تضمين وسم واحد في مخرجاته:

- `[[reply_to_current]]` — الرد على رسالة Discord المُحفِّزة.
- `[[reply_to:<id>]]` — الرد على معرّف رسالة محدد من السياق/السجل.
  تُلحَق معرّفات الرسائل الحالية بالمطالبات كـ `[message_id: …]`؛ وتتضمن إدخالات السجل المعرّفات بالفعل.

يُتحكَّم بالسلوك عبر `channels.discord.replyToMode`:

- `off`: تجاهل الوسوم.
- `first`: يكون الجزء/المرفق الصادر الأول فقط ردًا.
- `all`: يكون كل جزء/مرفق صادر ردًا.

ملاحظات مطابقة قوائم السماح:

- تقبل `allowFrom`/`users`/`groupChannels` المعرّفات، والأسماء، والوسوم، أو الإشارات مثل `<@id>`.
- تُدعَم البوادئ مثل `discord:`/`user:` (للمستخدمين) و `channel:` (للرسائل المباشرة الجماعية).
- استخدم `*` للسماح لأي مرسل/قناة.
- عند وجود `guilds.<id>.channels`، تُرفَض القنوات غير المدرجة افتراضيًا.
- عند حذف `guilds.<id>.channels`، تُسمَح جميع القنوات في الخادم المدرج.
- للسماح **بعدم وجود قنوات**، عيّن `channels.discord.groupPolicy: "disabled"` (أو أبقِ قائمة السماح فارغة).
- يقبل معالج التهيئة أسماء `Guild/Channel` (العامة + الخاصة) ويحلّها إلى معرّفات عند الإمكان.
- عند بدء التشغيل، يحل OpenClaw أسماء القنوات/المستخدمين في قوائم السماح إلى معرّفات (عندما يستطيع البوت البحث عن الأعضاء)
  ويسجّل الربط؛ وتُحفَظ الإدخالات غير المحلولة كما كُتبت.

ملاحظات الأوامر الأصلية:

- تعكس الأوامر المسجّلة أوامر الدردشة في OpenClaw.
- تلتزم الأوامر الأصلية بقوائم السماح نفسها الخاصة بالرسائل المباشرة/رسائل الخوادم (`channels.discord.dm.allowFrom`، `channels.discord.guilds`، قواعد لكل قناة).
- قد تبقى أوامر Slash مرئية في واجهة Discord لمستخدمين غير مُدرجين؛ يفرض OpenClaw قوائم السماح عند التنفيذ ويرد «غير مخوّل».

## إجراءات الأدوات

يمكن للوكيل استدعاء `discord` بإجراءات مثل:

- `react` / `reactions` (إضافة أو سرد التفاعلات)
- `sticker`، `poll`، `permissions`
- `readMessages`، `sendMessage`، `editMessage`، `deleteMessage`
- تتضمن حمولات أدوات القراءة/البحث/التثبيت `timestampMs` المُوحَّد (UTC epoch ms) و `timestampUtc` إلى جانب `timestamp` الخام من Discord.
- `threadCreate`، `threadList`، `threadReply`
- `pinMessage`، `unpinMessage`، `listPins`
- `searchMessages`، `memberInfo`، `roleInfo`، `roleAdd`، `roleRemove`، `emojiList`
- `channelInfo`، `channelList`، `voiceStatus`، `eventList`، `eventCreate`
- `timeout`، `kick`، `ban`
- `setPresence` (نشاط البوت وحالة الاتصال)

تُعرَض معرّفات رسائل Discord في السياق المُحقن (`[discord message id: …]` وأسطر السجل) حتى يتمكن الوكيل من استهدافها.
يمكن أن تكون الإيموجي Unicode (مثل `✅`) أو بصيغة إيموجي مخصّصة مثل `<:party_blob:1234567890>`.

## السلامة والتشغيل

- تعامل مع رمز البوت ككلمة مرور؛ فضّل متغير البيئة `DISCORD_BOT_TOKEN` على المضيفين الخاضعين للإشراف أو شدّد أذونات ملف التهيئة.
- امنح البوت فقط الأذونات التي يحتاجها (عادةً قراءة/إرسال الرسائل).
- إذا علِق البوت أو وصل إلى حدود المعدل، أعد تشغيل الـ Gateway (`openclaw gateway --force`) بعد التأكد من عدم وجود عمليات أخرى تمتلك جلسة Discord.
