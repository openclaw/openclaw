---
summary: "Gateway + CLI 를 통한 투표 전송"
read_when:
  - 투표 지원을 추가하거나 수정할 때
  - CLI 또는 Gateway 에서 투표 전송을 디버깅할 때
title: "투표"
x-i18n:
  source_path: docs/automation/poll.md
---

# 투표

## 지원 채널

- Telegram
- WhatsApp (웹 채널)
- Discord
- Microsoft Teams (Adaptive Cards)

## CLI

```bash
# Telegram
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300

# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# Microsoft Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

옵션:

- `--channel`: `whatsapp` (기본값), `telegram`, `discord`, 또는 `msteams`
- `--poll-multi`: 여러 옵션 선택 허용
- `--poll-duration-hours`: Discord 전용 (생략 시 기본값 24)
- `--poll-duration-seconds`: Telegram 전용 (5-600 초)
- `--poll-anonymous` / `--poll-public`: Telegram 전용 투표 가시성

## Gateway RPC

메서드: `poll`

파라미터:

- `to` (string, 필수)
- `question` (string, 필수)
- `options` (string[], 필수)
- `maxSelections` (number, 선택사항)
- `durationHours` (number, 선택사항)
- `durationSeconds` (number, 선택사항, Telegram 전용)
- `isAnonymous` (boolean, 선택사항, Telegram 전용)
- `channel` (string, 선택사항, 기본값: `whatsapp`)
- `idempotencyKey` (string, 필수)

## 채널 차이점

- Telegram: 2-10 개 옵션. `threadId` 또는 `:topic:` 대상을 통해 포럼 주제를 지원합니다. `durationHours` 대신 `durationSeconds`를 사용하며 5-600 초로 제한됩니다. 익명 및 공개 투표를 지원합니다.
- WhatsApp: 2-12 개 옵션, `maxSelections`는 옵션 수 내여야 하며, `durationHours`를 무시합니다.
- Discord: 2-10 개 옵션, `durationHours`는 1-768 시간으로 클램핑됩니다 (기본값 24). `maxSelections > 1`은 다중 선택을 활성화합니다; Discord 는 엄격한 선택 수를 지원하지 않습니다.
- Microsoft Teams: Adaptive Card 투표 (OpenClaw 관리). 네이티브 투표 API 없음; `durationHours`는 무시됩니다.

## 에이전트 도구 (Message)

`poll` 액션과 함께 `message` 도구를 사용합니다 (`to`, `pollQuestion`, `pollOption`, 선택적 `pollMulti`, `pollDurationHours`, `channel`).

Telegram 의 경우 도구는 `pollDurationSeconds`, `pollAnonymous`, `pollPublic`도 허용합니다.

투표 생성에는 `action: "poll"`을 사용합니다. `action: "send"`와 함께 전달된 투표 필드는 거부됩니다.

참고: Discord 에는 "정확히 N 개 선택" 모드가 없습니다; `pollMulti`는 다중 선택에 매핑됩니다.
Teams 투표는 Adaptive Cards 로 렌더링되며 투표를 `~/.openclaw/msteams-polls.json`에 기록하기 위해 Gateway 가 온라인 상태를 유지해야 합니다.
