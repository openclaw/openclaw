---
summary: "`openclaw message`의 CLI 참조 (메시지 전송 + 채널 작업)"
read_when:
  - 메시지 CLI 작업 추가 또는 수정
  - 아웃바운드 채널 동작 변경
title: "message"
---

# `openclaw message`

메시지 전송 및 채널 작업을 위한 단일 아웃바운드 명령어
(Discord/Google Chat/Slack/Mattermost (플러그인)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Usage

```
openclaw message <subcommand> [flags]
```

채널 선택:

- 둘 이상의 채널이 구성된 경우 `--channel`이 필요합니다.
- 정확히 하나의 채널이 구성된 경우, 그 채널이 기본값이 됩니다.
- 값: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost는 플러그인 필요)

타겟 형식 (`--target`):

- WhatsApp: E.164 또는 그룹 JID
- Telegram: 채팅 ID 또는 `@username`
- Discord: `channel:<id>` 또는 `user:<id>` (또는 `<@id>` 멘션; 숫자 ID는 채널로 처리)
- Google Chat: `spaces/<spaceId>` 또는 `users/<userId>`
- Slack: `channel:<id>` 또는 `user:<id>` (숫자 채널 ID 허용)
- Mattermost (플러그인): `channel:<id>`, `user:<id>`, 또는 `@username` (숫자 ID는 채널로 처리)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, 또는 `username:<name>`/`u:<name>`
- iMessage: 핸들, `chat_id:<id>`, `chat_guid:<guid>`, 또는 `chat_identifier:<id>`
- MS Teams: conversation ID (`19:...@thread.tacv2`) 또는 `conversation:<id>` 또는 `user:<aad-object-id>`

이름 조회:

- 지원되는 프로바이더에 대해 (Discord/Slack 등), `Help` 또는 `#help`와 같은 채널 이름은 디렉토리 캐시를 통해 해석됩니다.
- 캐시 미스 시, OpenClaw는 프로바이더가 지원할 경우 라이브 디렉토리 조회를 시도합니다.

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (전송/설문조사/읽기 등 대상 채널 또는 사용자)
- `--targets <name>` (반복; 방송만 해당)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - 채널: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage/MS Teams
  - 필수: `--target`, 그리고 `--message` 또는 `--media`
  - 선택: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram 전용: `--buttons` (`channels.telegram.capabilities.inlineButtons`가 허용해야 사용 가능)
  - Telegram 전용: `--thread-id` (포럼 토픽 ID)
  - Slack 전용: `--thread-id` (쓰레드 타임스탬프; `--reply-to`도 같은 필드 사용)
  - WhatsApp 전용: `--gif-playback`

- `poll`
  - 채널: WhatsApp/Telegram/Discord/Matrix/MS Teams
  - 필수: `--target`, `--poll-question`, `--poll-option` (반복)
  - 선택: `--poll-multi`
  - Discord 전용: `--poll-duration-hours`, `--silent`, `--message`
  - Telegram 전용: `--poll-duration-seconds` (5-600), `--silent`, `--poll-anonymous` / `--poll-public`, `--thread-id`

- `react`
  - 채널: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 필수: `--message-id`, `--target`
  - 선택: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - 주의: `--remove`는 `--emoji`가 필요 (지원되는 경우 자신의 리액션을 삭제하려면 `--emoji` 생략; see /tools/reactions)
  - WhatsApp 전용: `--participant`, `--from-me`
  - Signal 그룹 리액션: `--target-author` 또는 `--target-author-uuid`가 필요

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
  - 필수: `--thread-name`, `--target` (채널 ID)
  - 선택: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - 채널: Discord
  - 필수: `--guild-id`
  - 선택: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - 채널: Discord
  - 필수: `--target` (쓰레드 ID), `--message`
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
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - 선택: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (선택적 `--duration-min` 또는 `--until`; 둘 다 생략하면 타임아웃 해제)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` 또한 `--reason` 지원

### Broadcast

- `broadcast`
  - 채널: 구성된 모든 채널; 모든 프로바이더 대상은 `--channel all` 사용
  - 필수: `--targets` (반복)
  - 선택: `--message`, `--media`, `--dry-run`

## Examples

Discord에 응답 보내기:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord에 컴포넌트가 포함된 메시지 보내기:

```
openclaw message send --channel discord \
  --target channel:123 --message "Choose:" \
  --components '{"text":"Choose a path","blocks":[{"type":"actions","buttons":[{"label":"Approve","style":"success"},{"label":"Decline","style":"danger"}]}]}'
```

전체 스키마는 [Discord 컴포넌트](/ko-KR/channels/discord#interactive-components)를 참조하세요.

Discord에 설문조사 생성:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Telegram에서 자동으로 2분 후 닫히는 설문조사 생성:

```
openclaw message poll --channel telegram \
  --target @mychat \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-duration-seconds 120 --silent
```

Teams에 사전 알림 메시지 보내기:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams에 설문조사 생성:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack에서 리액션 추가:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signal 그룹에서 리액션 추가:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram에서 인라인 버튼 보내기:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
