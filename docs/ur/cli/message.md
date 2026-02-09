---
summary: "CLI حوالہ برائے `openclaw message` (بھیجنا + چینل اعمال)"
read_when:
  - پیغام CLI اعمال شامل یا تبدیل کرتے وقت
  - آؤٹ باؤنڈ چینل کے رویّے میں تبدیلی کرتے وقت
title: "message"
---

# `openclaw message`

پیغامات بھیجنے اور چینل اعمال کے لیے واحد آؤٹ باؤنڈ کمانڈ
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams)۔

## Usage

```
openclaw message <subcommand> [flags]
```

چینل کا انتخاب:

- `--channel` درکار ہے اگر ایک سے زیادہ چینل کنفیگر ہوں۔
- اگر بالکل ایک چینل کنفیگر ہو، تو وہی بطورِ طے شدہ استعمال ہوگا۔
- اقدار: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost کے لیے plugin درکار ہے)

ہدف کی فارمیٹس (`--target`):

- WhatsApp: E.164 یا گروپ JID
- Telegram: chat id یا `@username`
- Discord: `channel:<id>` یا `user:<id>` (یا `<@id>` ذکر؛ خام عددی ids کو چینلز سمجھا جاتا ہے)
- Google Chat: `spaces/<spaceId>` یا `users/<userId>`
- Slack: `channel:<id>` یا `user:<id>` (خام چینل id قبول ہے)
- Mattermost (plugin): `channel:<id>`، `user:<id>`، یا `@username` (سادہ ids کو چینلز سمجھا جاتا ہے)
- Signal: `+E.164`، `group:<id>`، `signal:+E.164`، `signal:group:<id>`، یا `username:<name>`/`u:<name>`
- iMessage: handle، `chat_id:<id>`، `chat_guid:<guid>`، یا `chat_identifier:<id>`
- MS Teams: گفتگو id (`19:...@thread.tacv2`) یا `conversation:<id>` یا `user:<aad-object-id>`

نام کی تلاش:

- معاون فراہم کنندگان (Discord/Slack وغیرہ) کے لیے، چینل نام جیسے `Help` یا `#help` ڈائریکٹری کیش کے ذریعے حل کیے جاتے ہیں۔
- کیش مس ہونے پر، جب فراہم کنندہ سپورٹ کرے تو OpenClaw لائیو ڈائریکٹری تلاش کی کوشش کرے گا۔

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (بھیجنے/پول/پڑھنے وغیرہ کے لیے ہدف چینل یا صارف)
- `--targets <name>` (دہرائیں؛ صرف براڈکاسٹ)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - چینلز: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - درکار: `--target`، نیز `--message` یا `--media`
  - اختیاری: `--media`، `--reply-to`، `--thread-id`، `--gif-playback`
  - صرف Telegram: `--buttons` (اس کی اجازت کے لیے `channels.telegram.capabilities.inlineButtons` درکار)
  - صرف Telegram: `--thread-id` (forum topic id)
  - صرف Slack: `--thread-id` (thread timestamp؛ `--reply-to` اسی فیلڈ کو استعمال کرتا ہے)
  - صرف WhatsApp: `--gif-playback`

- `poll`
  - چینلز: WhatsApp/Discord/MS Teams
  - درکار: `--target`، `--poll-question`، `--poll-option` (دہرائیں)
  - اختیاری: `--poll-multi`
  - صرف Discord: `--poll-duration-hours`، `--message`

- `react`
  - چینلز: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - درکار: `--message-id`، `--target`
  - اختیاری: `--emoji`، `--remove`، `--participant`، `--from-me`، `--target-author`، `--target-author-uuid`
  - نوٹ: `--remove` کے لیے `--emoji` درکار ہے (`--emoji` کو چھوڑ دیں تاکہ جہاں سپورٹ ہو اپنی ری ایکشنز صاف کی جا سکیں؛ /tools/reactions دیکھیں)
  - صرف WhatsApp: `--participant`، `--from-me`
  - Signal گروپ ری ایکشنز: `--target-author` یا `--target-author-uuid` درکار

- `reactions`
  - چینلز: Discord/Google Chat/Slack
  - درکار: `--message-id`، `--target`
  - اختیاری: `--limit`

- `read`
  - چینلز: Discord/Slack
  - درکار: `--target`
  - اختیاری: `--limit`، `--before`، `--after`
  - صرف Discord: `--around`

- `edit`
  - چینلز: Discord/Slack
  - درکار: `--message-id`، `--message`، `--target`

- `delete`
  - چینلز: Discord/Slack/Telegram
  - درکار: `--message-id`، `--target`

- `pin` / `unpin`
  - چینلز: Discord/Slack
  - درکار: `--message-id`، `--target`

- `pins` (فہرست)
  - چینلز: Discord/Slack
  - درکار: `--target`

- `permissions`
  - چینلز: Discord
  - درکار: `--target`

- `search`
  - چینلز: Discord
  - درکار: `--guild-id`، `--query`
  - اختیاری: `--channel-id`، `--channel-ids` (دہرائیں)، `--author-id`، `--author-ids` (دہرائیں)، `--limit`

### Threads

- `thread create`
  - چینلز: Discord
  - درکار: `--thread-name`، `--target` (چینل id)
  - اختیاری: `--message-id`، `--message`، `--auto-archive-min`

- `thread list`
  - چینلز: Discord
  - درکار: `--guild-id`
  - اختیاری: `--channel-id`، `--include-archived`، `--before`، `--limit`

- `thread reply`
  - چینلز: Discord
  - درکار: `--target` (thread id)، `--message`
  - اختیاری: `--media`، `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: اضافی فلیگز نہیں

- `emoji upload`
  - چینلز: Discord
  - درکار: `--guild-id`، `--emoji-name`، `--media`
  - اختیاری: `--role-ids` (دہرائیں)

### Stickers

- `sticker send`
  - چینلز: Discord
  - درکار: `--target`، `--sticker-id` (دہرائیں)
  - اختیاری: `--message`

- `sticker upload`
  - چینلز: Discord
  - درکار: `--guild-id`، `--sticker-name`، `--sticker-desc`، `--sticker-tags`، `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`، `--user-id`، `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ Discord کے لیے `--guild-id`)
- `voice status` (Discord): `--guild-id`، `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`، `--event-name`، `--start-time`
  - اختیاری: `--end-time`، `--desc`، `--channel-id`، `--location`، `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`، `--user-id` (اختیاری `--duration-min` یا `--until`؛ دونوں چھوڑنے پر ٹائم آؤٹ صاف ہو جائے گا)
- `kick`: `--guild-id`، `--user-id` (+ `--reason`)
- `ban`: `--guild-id`، `--user-id` (+ `--delete-days`، `--reason`)
  - `timeout` بھی `--reason` کو سپورٹ کرتا ہے

### Broadcast

- `broadcast`
  - چینلز: کوئی بھی کنفیگر شدہ چینل؛ تمام فراہم کنندگان کو ہدف بنانے کے لیے `--channel all` استعمال کریں
  - درکار: `--targets` (دہرائیں)
  - اختیاری: `--message`، `--media`، `--dry-run`

## Examples

Discord میں جواب بھیجیں:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord پول بنائیں:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Teams میں proactive پیغام بھیجیں:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams پول بنائیں:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack میں ری ایکٹ کریں:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signal گروپ میں ری ایکٹ کریں:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram inline بٹن بھیجیں:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
