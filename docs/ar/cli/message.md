---
summary: "مرجع CLI للأمر `openclaw message` (الإرسال + إجراءات القنوات)"
read_when:
  - إضافة إجراءات CLI للرسائل أو تعديلها
  - تغيير سلوك القنوات الصادرة
title: "message"
---

# `openclaw message`

أمر صادر واحد لإرسال الرسائل وتنفيذ إجراءات القنوات
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Usage

```
openclaw message <subcommand> [flags]
```

اختيار القناة:

- `--channel` مطلوب إذا تم تهيئة أكثر من قناة واحدة.
- إذا كانت هناك قناة واحدة فقط مُهيّأة، فستصبح هي الافتراضية.
- القيم: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (يتطلب Mattermost إضافة plugin)

تنسيقات الهدف (`--target`):

- WhatsApp: E.164 أو JID لمجموعة
- Telegram: معرّف الدردشة أو `@username`
- Discord: `channel:<id>` أو `user:<id>` (أو إشارة `<@id>`؛ تُعامَل المعرّفات الرقمية الخام كقنوات)
- Google Chat: `spaces/<spaceId>` أو `users/<userId>`
- Slack: `channel:<id>` أو `user:<id>` (يُقبل معرّف القناة الخام)
- Mattermost (plugin): `channel:<id>`، `user:<id>`، أو `@username` (تُعامَل المعرّفات العارية كقنوات)
- Signal: `+E.164`، `group:<id>`، `signal:+E.164`، `signal:group:<id>`، أو `username:<name>`/`u:<name>`
- iMessage: معرّف جهة الاتصال، `chat_id:<id>`، `chat_guid:<guid>`، أو `chat_identifier:<id>`
- MS Teams: معرّف المحادثة (`19:...@thread.tacv2`) أو `conversation:<id>` أو `user:<aad-object-id>`

البحث بالاسم:

- لموفّري الخدمة المدعومين (Discord/Slack/etc)، تُحل أسماء القنوات مثل `Help` أو `#help` عبر ذاكرة التخزين المؤقت للدليل.
- عند فقدان ذاكرة التخزين المؤقت، سيحاول OpenClaw إجراء بحث مباشر في الدليل عندما يدعمه الموفّر.

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (قناة أو مستخدم مستهدف للإرسال/الاستطلاع/القراءة/etc)
- `--targets <name>` (تكرار؛ للبث فقط)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - القنوات: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - مطلوب: `--target`، بالإضافة إلى `--message` أو `--media`
  - اختياري: `--media`، `--reply-to`، `--thread-id`، `--gif-playback`
  - Telegram فقط: `--buttons` (يتطلب `channels.telegram.capabilities.inlineButtons` للسماح به)
  - Telegram فقط: `--thread-id` (معرّف موضوع المنتدى)
  - Slack فقط: `--thread-id` (طابع زمني لسلسلة؛ يستخدم `--reply-to` الحقل نفسه)
  - WhatsApp فقط: `--gif-playback`

- `poll`
  - القنوات: WhatsApp/Discord/MS Teams
  - مطلوب: `--target`، `--poll-question`، `--poll-option` (تكرار)
  - اختياري: `--poll-multi`
  - Discord فقط: `--poll-duration-hours`، `--message`

- `react`
  - القنوات: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - مطلوب: `--message-id`، `--target`
  - اختياري: `--emoji`، `--remove`، `--participant`، `--from-me`، `--target-author`، `--target-author-uuid`
  - ملاحظة: يتطلب `--remove` وجود `--emoji` (احذف `--emoji` لمسح تفاعلاتك حيثما كان ذلك مدعومًا؛ راجع /tools/reactions)
  - WhatsApp فقط: `--participant`، `--from-me`
  - تفاعلات مجموعات Signal: مطلوب `--target-author` أو `--target-author-uuid`

- `reactions`
  - القنوات: Discord/Google Chat/Slack
  - مطلوب: `--message-id`، `--target`
  - اختياري: `--limit`

- `read`
  - القنوات: Discord/Slack
  - مطلوب: `--target`
  - اختياري: `--limit`، `--before`، `--after`
  - Discord فقط: `--around`

- `edit`
  - القنوات: Discord/Slack
  - مطلوب: `--message-id`، `--message`، `--target`

- `delete`
  - القنوات: Discord/Slack/Telegram
  - مطلوب: `--message-id`، `--target`

- `pin` / `unpin`
  - القنوات: Discord/Slack
  - مطلوب: `--message-id`، `--target`

- `pins` (قائمة)
  - القنوات: Discord/Slack
  - مطلوب: `--target`

- `permissions`
  - القنوات: Discord
  - مطلوب: `--target`

- `search`
  - القنوات: Discord
  - مطلوب: `--guild-id`، `--query`
  - اختياري: `--channel-id`، `--channel-ids` (تكرار)، `--author-id`، `--author-ids` (تكرار)، `--limit`

### Threads

- `thread create`
  - القنوات: Discord
  - مطلوب: `--thread-name`، `--target` (معرّف القناة)
  - اختياري: `--message-id`، `--message`، `--auto-archive-min`

- `thread list`
  - القنوات: Discord
  - مطلوب: `--guild-id`
  - اختياري: `--channel-id`، `--include-archived`، `--before`، `--limit`

- `thread reply`
  - القنوات: Discord
  - مطلوب: `--target` (معرّف السلسلة)، `--message`
  - اختياري: `--media`، `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: لا توجد أعلام إضافية

- `emoji upload`
  - القنوات: Discord
  - مطلوب: `--guild-id`، `--emoji-name`، `--media`
  - اختياري: `--role-ids` (تكرار)

### Stickers

- `sticker send`
  - القنوات: Discord
  - مطلوب: `--target`، `--sticker-id` (تكرار)
  - اختياري: `--message`

- `sticker upload`
  - القنوات: Discord
  - مطلوب: `--guild-id`، `--sticker-name`، `--sticker-desc`، `--sticker-tags`، `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`، `--user-id`، `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` لـ Discord)
- `voice status` (Discord): `--guild-id`، `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`، `--event-name`، `--start-time`
  - اختياري: `--end-time`، `--desc`، `--channel-id`، `--location`، `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`، `--user-id` (اختياري `--duration-min` أو `--until`؛ احذف كليهما لمسح المهلة)
- `kick`: `--guild-id`، `--user-id` (+ `--reason`)
- `ban`: `--guild-id`، `--user-id` (+ `--delete-days`، `--reason`)
  - يدعم `timeout` أيضًا `--reason`

### Broadcast

- `broadcast`
  - القنوات: أي قناة مُهيّأة؛ استخدم `--channel all` لاستهداف جميع الموفّرين
  - مطلوب: `--targets` (تكرار)
  - اختياري: `--message`، `--media`، `--dry-run`

## Examples

إرسال رد في Discord:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

إنشاء استطلاع في Discord:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

إرسال رسالة استباقية في Teams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

إنشاء استطلاع في Teams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

التفاعل في Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

التفاعل في مجموعة Signal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

إرسال أزرار مضمّنة في Telegram:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
