---
summary: "`openclaw message` 에 대한 CLI 참조 (전송 + 채널 작업)"
read_when:
  - 메시지 CLI 작업을 추가하거나 수정할 때
  - 아웃바운드 채널 동작을 변경할 때
title: "message"
---

# `openclaw message`

메시지 전송 및 채널 작업을 위한 단일 아웃바운드 명령
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Usage

```
openclaw message <subcommand> [flags]
```

채널 선택:

- `--channel` 는 둘 이상의 채널이 구성된 경우 필수입니다.
- 정확히 하나의 채널만 구성된 경우 해당 채널이 기본값이 됩니다.
- 값: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost 는 plugin 필요)

대상 형식 (`--target`):

- WhatsApp: E.164 또는 그룹 JID
- Telegram: chat id 또는 `@username`
- Discord: `channel:<id>` 또는 `user:<id>` (또는 `<@id>` 멘션; 원시 숫자 id 는 채널로 처리됩니다)
- Google Chat: `spaces/<spaceId>` 또는 `users/<userId>`
- Slack: `channel:<id>` 또는 `user:<id>` (원시 채널 id 허용)
- Mattermost (plugin): `channel:<id>`, `user:<id>`, 또는 `@username` (단순 id 는 채널로 처리됩니다)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, 또는 `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, 또는 `chat_identifier:<id>`
- MS Teams: 대화 id (`19:...@thread.tacv2`) 또는 `conversation:<id>` 또는 `user:<aad-object-id>`

이름 조회:

- 지원되는 프로바이더 (Discord/Slack 등) 에서는 `Help` 또는 `#help` 와 같은 채널 이름이 디렉토리 캐시를 통해 해석됩니다.
- 캐시 미스 시, 프로바이더가 지원하는 경우 OpenClaw 가 라이브 디렉토리 조회를 시도합니다.

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (send/poll/read 등에서 대상 채널 또는 사용자)
- `--targets <name>` (반복; 브로드캐스트 전용)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - 채널: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - 필수: `--target`, 그리고 `--message` 또는 `--media`
  - 선택: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram 전용: `--buttons` (`channels.telegram.capabilities.inlineButtons` 가 이를 허용하도록 필요)
  - Telegram 전용: `--thread-id` (포럼 토픽 id)
  - Slack 전용: `--thread-id` (스레드 타임스탬프; `--reply-to` 도 동일 필드 사용)
  - WhatsApp 전용: `--gif-playback`

- `poll`
  - 채널: WhatsApp/Discord/MS Teams
  - 필수: `--target`, `--poll-question`, `--poll-option` (반복)
  - 선택: `--poll-multi`
  - Discord 전용: `--poll-duration-hours`, `--message`

- `react`
  - 채널: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 필수: `--message-id`, `--target`
  - 선택: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - 참고: `--remove` 는 `--emoji` 가 필요합니다 (지원되는 경우 자신의 반응을 지우려면 `--emoji` 을 생략; /tools/reactions 참조).
  - WhatsApp 전용: `--participant`, `--from-me`
  - Signal 그룹 반응: `--target-author` 또는 `--target-author-uuid` 필수

- `reactions`
  - 채널: Discord/Google Chat/Slack
  - 필수: `--message-id`, `--target`
  - 선택: `--limit`

- `read`
  - 채널: Discord/Slack
  - 필수: `--target`
  - 선택: `--limit`, `--before`, `--after`
  - Discord 전용: `--around`

- `edit`
  - 채널: Discord/Slack
  - 필수: `--message-id`, `--message`, `--target`

- `delete`
  - 채널: Discord/Slack/Telegram
  - 필수: `--message-id`, `--target`

- `pin` / `unpin`
  - 채널: Discord/Slack
  - 필수: `--message-id`, `--target`

- `pins` (목록)
  - 채널: Discord/Slack
  - 필수: `--target`

- `permissions`
  - 채널: Discord
  - 필수: `--target`

- `search`
  - 채널: Discord
  - 필수: `--guild-id`, `--query`
  - 선택: `--channel-id`, `--channel-ids` (반복), `--author-id`, `--author-ids` (반복), `--limit`

### Threads

- `thread create`
  - 채널: Discord
  - 필수: `--thread-name`, `--target` (채널 id)
  - 선택: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - 채널: Discord
  - 필수: `--guild-id`
  - 선택: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - 채널: Discord
  - 필수: `--target` (스레드 id), `--message`
  - 선택: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: 추가 플래그 없음

- `emoji upload`
  - 채널: Discord
  - 필수: `--guild-id`, `--emoji-name`, `--media`
  - 선택: `--role-ids` (반복)

### Stickers

- `sticker send`
  - 채널: Discord
  - 필수: `--target`, `--sticker-id` (반복)
  - 선택: `--message`

- `sticker upload`
  - 채널: Discord
  - 필수: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ Discord 의 경우 `--guild-id`)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - 선택: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (선택 `--duration-min` 또는 `--until`; 둘 다 생략하면 타임아웃 해제)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` 는 `--reason` 도 지원합니다

### Broadcast

- `broadcast`
  - 채널: 구성된 모든 채널; 모든 프로바이더를 대상으로 하려면 `--channel all` 사용
  - 필수: `--targets` (반복)
  - 선택: `--message`, `--media`, `--dry-run`

## Examples

Discord 에서 답장 보내기:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord 투표 생성:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Teams 선제적 메시지 보내기:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams 투표 생성:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack 에서 반응 추가:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signal 그룹에서 반응 추가:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram 인라인 버튼 보내기:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
