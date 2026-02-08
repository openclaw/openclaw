---
read_when:
    - 메시지 CLI 작업 추가 또는 수정
    - 아웃바운드 채널 동작 변경
summary: '`openclaw message`에 대한 CLI 참조(전송 + 채널 작업)'
title: 메시지
x-i18n:
    generated_at: "2026-02-08T15:53:10Z"
    model: gtx
    provider: google-translate
    source_hash: 7781b44b3998d27108f7996802ca2cedb4869749fffea5b09452f348827482dd
    source_path: cli/message.md
    workflow: 15
---

# `openclaw message`

메시지 및 채널 작업 전송을 위한 단일 아웃바운드 명령
(Discord/Google Chat/Slack/Mattermost(플러그인)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## 용법

```
openclaw message <subcommand> [flags]
```

채널 선택:

- `--channel` 둘 이상의 채널이 구성된 경우 필요합니다.
- 정확히 하나의 채널이 구성되면 해당 채널이 기본값이 됩니다.
- 값: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost에는 플러그인이 필요합니다)

대상 형식(`--target`):

- WhatsApp: E.164 또는 그룹 JID
- 텔레그램: 채팅 ID 또는 `@username`
- 불화: `channel:<id>` 또는 `user:<id>` (또는 `<@id>` 언급하다; 원시 숫자 ID는 채널로 처리됩니다)
- 구글 채팅: `spaces/<spaceId>` 또는 `users/<userId>`
- 느슨하게: `channel:<id>` 또는 `user:<id>` (원시 채널 ID가 허용됩니다)
- Mattermost(플러그인): `channel:<id>`, `user:<id>`, 또는 `@username` (기본 ID는 채널로 처리됩니다)
- 신호: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, 또는 `username:<name>`/`u:<name>`
- iMessage: 처리, `chat_id:<id>`, `chat_guid:<guid>`, 또는 `chat_identifier:<id>`
- MS Teams: 대화 ID(`19:...@thread.tacv2`) 또는 `conversation:<id>` 또는 `user:<aad-object-id>`

이름 조회:

- 지원되는 제공업체(Discord/Slack/etc)의 경우 채널 이름은 다음과 같습니다. `Help` 또는 `#help` 디렉터리 캐시를 통해 해결됩니다.
- 캐시 누락 시 OpenClaw는 공급자가 지원하는 경우 라이브 디렉터리 조회를 시도합니다.

## 공통 플래그

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (보내기/폴링/읽기/등을 위한 대상 채널 또는 사용자)
- `--targets <name>` (반복; 방송 전용)
- `--json`
- `--dry-run`
- `--verbose`

## 행위

### 핵심

- `send`
  - 채널: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost(플러그인)/Signal/iMessage/MS Teams
  - 필수의: `--target`, 플러스 `--message` 또는 `--media`
  - 선택 과목: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - 텔레그램 전용: `--buttons` (요구 `channels.telegram.capabilities.inlineButtons` 그것을 허용하기 위해)
  - 텔레그램 전용: `--thread-id` (포럼 주제 ID)
  - Slack 전용: `--thread-id` (스레드 타임스탬프; `--reply-to` 동일한 필드를 사용함)
  - WhatsApp 전용: `--gif-playback`

- `poll`
  - 채널: WhatsApp/Discord/MS 팀
  - 필수의: `--target`, `--poll-question`, `--poll-option` (반복하다)
  - 선택 과목: `--poll-multi`
  - 불일치만: `--poll-duration-hours`, `--message`

- `react`
  - 채널: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 필수의: `--message-id`, `--target`
  - 선택 과목: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - 메모: `--remove` 필요하다 `--emoji` (생략 `--emoji` 지원되는 경우 자신의 반응을 삭제합니다. /tools/reactions 참조)
  - WhatsApp 전용: `--participant`, `--from-me`
  - 신호 그룹 반응: `--target-author` 또는 `--target-author-uuid` 필수의

- `reactions`
  - 채널: Discord/Google Chat/Slack
  - 필수의: `--message-id`, `--target`
  - 선택 과목: `--limit`

- `read`
  - 채널: 디스코드/슬랙
  - 필수의: `--target`
  - 선택 과목: `--limit`, `--before`, `--after`
  - 불일치만: `--around`

- `edit`
  - 채널: 디스코드/슬랙
  - 필수의: `--message-id`, `--message`, `--target`

- `delete`
  - 채널: 디스코드/슬랙/텔레그램
  - 필수의: `--message-id`, `--target`

- `pin`/`unpin`
  - 채널: 디스코드/슬랙
  - 필수의: `--message-id`, `--target`

- `pins` (목록)
  - 채널: 디스코드/슬랙
  - 필수의: `--target`

- `permissions`
  - 채널: 디스코드
  - 필수의: `--target`

- `search`
  - 채널: 디스코드
  - 필수의: `--guild-id`, `--query`
  - 선택 과목: `--channel-id`, `--channel-ids` (반복하다), `--author-id`, `--author-ids` (반복하다), `--limit`

### 스레드

- `thread create`
  - 채널: 디스코드
  - 필수의: `--thread-name`, `--target` (채널 ID)
  - 선택 과목: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - 채널: 디스코드
  - 필수의: `--guild-id`
  - 선택 과목: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - 채널: 디스코드
  - 필수의: `--target` (스레드 ID), `--message`
  - 선택 과목: `--media`, `--reply-to`

### 이모티콘

- `emoji list`
  - 불화: `--guild-id`
  - Slack: 추가 플래그 없음

- `emoji upload`
  - 채널: 디스코드
  - 필수의: `--guild-id`, `--emoji-name`, `--media`
  - 선택 과목: `--role-ids` (반복하다)

### 스티커

- `sticker send`
  - 채널: 디스코드
  - 필수의: `--target`, `--sticker-id` (반복하다)
  - 선택 과목: `--message`

- `sticker upload`
  - 채널: 디스코드
  - 필수의: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### 역할/채널/멤버/보이스

- `role info` (불화): `--guild-id`
- `role add`/`role remove` (불화): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (불화): `--target`
- `channel list` (불화): `--guild-id`
- `member info` (불화/슬랙): `--user-id` (+ `--guild-id` 디스코드용)
- `voice status` (불화): `--guild-id`, `--user-id`

### 이벤트

- `event list` (불화): `--guild-id`
- `event create` (불화): `--guild-id`, `--event-name`, `--start-time`
  - 선택 과목: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### 중재(불화)

- `timeout`: `--guild-id`, `--user-id` (선택 과목 `--duration-min` 또는 `--until`; 시간 초과를 지우려면 둘 다 생략)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` 또한 지원합니다 `--reason`

### 방송

- `broadcast`
  - 채널: 구성된 모든 채널. 사용 `--channel all` 모든 제공업체를 타겟팅하려면
  - 필수의: `--targets` (반복하다)
  - 선택 과목: `--message`, `--media`, `--dry-run`

## 예

Discord 답장 보내기:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord 설문조사 만들기:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Teams 사전 메시지 보내기:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams 설문조사를 만듭니다.

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack에서 반응:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

신호 그룹에서 반응:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

전보 보내기 인라인 버튼:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
