---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw message`(การส่งข้อความและการดำเนินการของช่องทาง)"
read_when:
  - การเพิ่มหรือแก้ไขการดำเนินการของmessageผ่านCLI
  - การเปลี่ยนพฤติกรรมช่องทางขาออก
title: "ข้อความ"
---

# `openclaw message`

คำสั่งขาออกเดียวสำหรับการส่งข้อความและการดำเนินการของช่องทาง
(Discord/Google Chat/Slack/Mattermost(ปลั๊กอิน)/Telegram/WhatsApp/Signal/iMessage/MS Teams)

## การใช้งาน

```
openclaw message <subcommand> [flags]
```

การเลือกช่องทาง:

- `--channel` จำเป็นหากมีการคอนฟิกมากกว่าหนึ่งช่องทาง
- หากคอนฟิกไว้เพียงหนึ่งช่องทาง ช่องทางนั้นจะถูกใช้เป็นค่าเริ่มต้น
- ค่า: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermostต้องใช้ปลั๊กอิน)

รูปแบบเป้าหมาย (`--target`):

- WhatsApp: E.164 หรือ group JID
- Telegram: chat id หรือ `@username`
- Discord: `channel:<id>` หรือ `user:<id>` (หรือการกล่าวถึง `<@id>`; id ตัวเลขดิบจะถูกมองว่าเป็นช่องทาง)
- Google Chat: `spaces/<spaceId>` หรือ `users/<userId>`
- Slack: `channel:<id>` หรือ `user:<id>` (ยอมรับ channel id ดิบ)
- Mattermost (ปลั๊กอิน): `channel:<id>`, `user:<id>`, หรือ `@username` (id เปล่าจะถูกมองว่าเป็นช่องทาง)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, หรือ `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, หรือ `chat_identifier:<id>`
- MS Teams: conversation id (`19:...@thread.tacv2`) หรือ `conversation:<id>` หรือ `user:<aad-object-id>`

การค้นหาชื่อ:

- สำหรับผู้ให้บริการที่รองรับ (Discord/Slack/etc) ชื่อช่องทางเช่น `Help` หรือ `#help` จะถูกแก้ไขผ่านแคชไดเรกทอรี
- หากไม่พบในแคช OpenClawจะพยายามค้นหาไดเรกทอรีแบบสดเมื่อผู้ให้บริการรองรับ

## แฟล็กที่ใช้บ่อย

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (ช่องทางหรือผู้ใช้เป้าหมายสำหรับ send/poll/read/etc)
- `--targets <name>` (ทำซ้ำ; ใช้กับการบรอดคาสต์เท่านั้น)
- `--json`
- `--dry-run`
- `--verbose`

## การดำเนินการ

### แกนหลัก

- `send`
  - ช่องทาง: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost(ปลั๊กอิน)/Signal/iMessage/MS Teams
  - จำเป็น: `--target` และ `--message` หรือ `--media`
  - ไม่บังคับ: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - เฉพาะTelegram: `--buttons` (ต้องใช้ `channels.telegram.capabilities.inlineButtons` เพื่ออนุญาต)
  - เฉพาะTelegram: `--thread-id` (forum topic id)
  - เฉพาะSlack: `--thread-id` (thread timestamp; `--reply-to` ใช้ฟิลด์เดียวกัน)
  - เฉพาะWhatsApp: `--gif-playback`

- `poll`
  - ช่องทาง: WhatsApp/Discord/MS Teams
  - จำเป็น: `--target`, `--poll-question`, `--poll-option` (ทำซ้ำ)
  - ไม่บังคับ: `--poll-multi`
  - เฉพาะDiscord: `--poll-duration-hours`, `--message`

- `react`
  - ช่องทาง: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - จำเป็น: `--message-id`, `--target`
  - ไม่บังคับ: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - หมายเหตุ: `--remove` ต้องใช้ `--emoji` (ละ `--emoji` เพื่อเคลียร์รีแอ็กชันของตนเองในกรณีที่รองรับ; ดู /tools/reactions)
  - เฉพาะWhatsApp: `--participant`, `--from-me`
  - รีแอ็กชันกลุ่มSignal: ต้องมี `--target-author` หรือ `--target-author-uuid`

- `reactions`
  - ช่องทาง: Discord/Google Chat/Slack
  - จำเป็น: `--message-id`, `--target`
  - ไม่บังคับ: `--limit`

- `read`
  - ช่องทาง: Discord/Slack
  - จำเป็น: `--target`
  - ไม่บังคับ: `--limit`, `--before`, `--after`
  - เฉพาะDiscord: `--around`

- `edit`
  - ช่องทาง: Discord/Slack
  - จำเป็น: `--message-id`, `--message`, `--target`

- `delete`
  - ช่องทาง: Discord/Slack/Telegram
  - จำเป็น: `--message-id`, `--target`

- `pin` / `unpin`
  - ช่องทาง: Discord/Slack
  - จำเป็น: `--message-id`, `--target`

- `pins` (รายการ)
  - ช่องทาง: Discord/Slack
  - จำเป็น: `--target`

- `permissions`
  - ช่องทาง: Discord
  - จำเป็น: `--target`

- `search`
  - ช่องทาง: Discord
  - จำเป็น: `--guild-id`, `--query`
  - ไม่บังคับ: `--channel-id`, `--channel-ids` (ทำซ้ำ), `--author-id`, `--author-ids` (ทำซ้ำ), `--limit`

### Threads

- `thread create`
  - ช่องทาง: Discord
  - จำเป็น: `--thread-name`, `--target` (channel id)
  - ไม่บังคับ: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - ช่องทาง: Discord
  - จำเป็น: `--guild-id`
  - ไม่บังคับ: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - ช่องทาง: Discord
  - จำเป็น: `--target` (thread id), `--message`
  - ไม่บังคับ: `--media`, `--reply-to`

### อีโมจิ

- `emoji list`
  - Discord: `--guild-id`
  - Slack: ไม่มีแฟล็กเพิ่มเติม

- `emoji upload`
  - ช่องทาง: Discord
  - จำเป็น: `--guild-id`, `--emoji-name`, `--media`
  - ไม่บังคับ: `--role-ids` (ทำซ้ำ)

### สติกเกอร์

- `sticker send`
  - ช่องทาง: Discord
  - จำเป็น: `--target`, `--sticker-id` (ทำซ้ำ)
  - ไม่บังคับ: `--message`

- `sticker upload`
  - ช่องทาง: Discord
  - จำเป็น: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### บทบาท/ช่องทาง/สมาชิก/เสียง

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` สำหรับDiscord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### อีเวนต์

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - ไม่บังคับ: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### การกลั่นกรอง (Discord)

- `timeout`: `--guild-id`, `--user-id` (ไม่บังคับ `--duration-min` หรือ `--until`; หากละทั้งคู่จะล้าง timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` ยังรองรับ `--reason`

### Broadcast

- `broadcast`
  - ช่องทาง: ช่องทางที่คอนฟิกไว้ทั้งหมด; ใช้ `--channel all` เพื่อกำหนดเป้าหมายทุกผู้ให้บริการ
  - จำเป็น: `--targets` (ทำซ้ำ)
  - ไม่บังคับ: `--message`, `--media`, `--dry-run`

## ตัวอย่าง

ส่งการตอบกลับในDiscord:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

สร้างโพลในDiscord:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

ส่งข้อความเชิงรุกในTeams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

สร้างโพลในTeams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

รีแอ็กต์ในSlack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

รีแอ็กต์ในกลุ่มSignal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

ส่งปุ่มแบบอินไลน์ในTelegram:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
