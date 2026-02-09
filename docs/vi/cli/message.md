---
summary: "Tài liệu tham chiếu CLI cho `openclaw message` (gửi + hành động kênh)"
read_when:
  - Thêm hoặc chỉnh sửa các hành động CLI của message
  - Thay đổi hành vi kênh gửi đi
title: "message"
---

# `openclaw message`

Lệnh gửi đi duy nhất để gửi tin nhắn và thực hiện các hành động kênh
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Usage

```
openclaw message <subcommand> [flags]
```

Chọn kênh:

- `--channel` bắt buộc nếu có hơn một kênh được cấu hình.
- Nếu chỉ có đúng một kênh được cấu hình, kênh đó sẽ trở thành mặc định.
- Giá trị: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost yêu cầu plugin)

Định dạng đích (`--target`):

- WhatsApp: E.164 hoặc JID nhóm
- Telegram: chat id hoặc `@username`
- Discord: `channel:<id>` hoặc `user:<id>` (hoặc đề cập `<@id>`; id số thô được coi là kênh)
- Google Chat: `spaces/<spaceId>` hoặc `users/<userId>`
- Slack: `channel:<id>` hoặc `user:<id>` (chấp nhận id kênh thô)
- Mattermost (plugin): `channel:<id>`, `user:<id>`, hoặc `@username` (id trần được coi là kênh)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, hoặc `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, hoặc `chat_identifier:<id>`
- MS Teams: conversation id (`19:...@thread.tacv2`) hoặc `conversation:<id>` hoặc `user:<aad-object-id>`

Tra cứu theo tên:

- Với các nhà cung cấp được hỗ trợ (Discord/Slack/etc), tên kênh như `Help` hoặc `#help` được phân giải qua bộ nhớ đệm thư mục.
- Khi trượt bộ nhớ đệm, OpenClaw sẽ cố gắng tra cứu thư mục trực tiếp khi nhà cung cấp hỗ trợ.

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (kênh hoặc người dùng đích cho send/poll/read/etc)
- `--targets <name>` (lặp lại; chỉ broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Kênh: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Bắt buộc: `--target`, cùng với `--message` hoặc `--media`
  - Tùy chọn: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Chỉ Telegram: `--buttons` (yêu cầu `channels.telegram.capabilities.inlineButtons` để cho phép)
  - Chỉ Telegram: `--thread-id` (id chủ đề diễn đàn)
  - Chỉ Slack: `--thread-id` (dấu thời gian luồng; `--reply-to` dùng cùng trường)
  - Chỉ WhatsApp: `--gif-playback`

- `poll`
  - Kênh: WhatsApp/Discord/MS Teams
  - Bắt buộc: `--target`, `--poll-question`, `--poll-option` (lặp lại)
  - Tùy chọn: `--poll-multi`
  - Chỉ Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kênh: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Bắt buộc: `--message-id`, `--target`
  - Tùy chọn: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Lưu ý: `--remove` yêu cầu `--emoji` (bỏ `--emoji` để xóa phản ứng của chính mình khi được hỗ trợ; xem /tools/reactions)
  - Chỉ WhatsApp: `--participant`, `--from-me`
  - Phản ứng nhóm Signal: cần `--target-author` hoặc `--target-author-uuid`

- `reactions`
  - Kênh: Discord/Google Chat/Slack
  - Bắt buộc: `--message-id`, `--target`
  - Tùy chọn: `--limit`

- `read`
  - Kênh: Discord/Slack
  - Bắt buộc: `--target`
  - Tùy chọn: `--limit`, `--before`, `--after`
  - Chỉ Discord: `--around`

- `edit`
  - Kênh: Discord/Slack
  - Bắt buộc: `--message-id`, `--message`, `--target`

- `delete`
  - Kênh: Discord/Slack/Telegram
  - Bắt buộc: `--message-id`, `--target`

- `pin` / `unpin`
  - Kênh: Discord/Slack
  - Bắt buộc: `--message-id`, `--target`

- `pins` (list)
  - Kênh: Discord/Slack
  - Bắt buộc: `--target`

- `permissions`
  - Kênh: Discord
  - Bắt buộc: `--target`

- `search`
  - Kênh: Discord
  - Bắt buộc: `--guild-id`, `--query`
  - Tùy chọn: `--channel-id`, `--channel-ids` (lặp lại), `--author-id`, `--author-ids` (lặp lại), `--limit`

### Threads

- `thread create`
  - Kênh: Discord
  - Bắt buộc: `--thread-name`, `--target` (id kênh)
  - Tùy chọn: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kênh: Discord
  - Bắt buộc: `--guild-id`
  - Tùy chọn: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kênh: Discord
  - Bắt buộc: `--target` (id thread), `--message`
  - Tùy chọn: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: không có cờ bổ sung

- `emoji upload`
  - Kênh: Discord
  - Bắt buộc: `--guild-id`, `--emoji-name`, `--media`
  - Tùy chọn: `--role-ids` (lặp lại)

### Stickers

- `sticker send`
  - Kênh: Discord
  - Bắt buộc: `--target`, `--sticker-id` (lặp lại)
  - Tùy chọn: `--message`

- `sticker upload`
  - Kênh: Discord
  - Bắt buộc: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` cho Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Tùy chọn: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (tùy chọn `--duration-min` hoặc `--until`; bỏ cả hai để xóa timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` cũng hỗ trợ `--reason`

### Broadcast

- `broadcast`
  - Kênh: bất kỳ kênh nào đã cấu hình; dùng `--channel all` để nhắm tới tất cả nhà cung cấp
  - Bắt buộc: `--targets` (lặp lại)
  - Tùy chọn: `--message`, `--media`, `--dry-run`

## Examples

Gửi một phản hồi Discord:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Tạo một cuộc thăm dò Discord:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Gửi tin nhắn chủ động trên Teams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Tạo một cuộc thăm dò Teams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Thả phản ứng trong Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Thả phản ứng trong một nhóm Signal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Gửi các nút nội tuyến Telegram:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
