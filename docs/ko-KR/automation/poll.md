---
summary: "Gateway + CLI를 통한 Poll 전송"
read_when:
  - "Poll 지원을 추가하거나 수정할 때"
  - "CLI 또는 Gateway에서 poll을 전송할 때"
title: "Poll"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/automation/poll.md
  workflow: 15
---

# Poll

## 지원되는 채널

- WhatsApp (웹 채널)
- Discord
- MS Teams (적응형 카드)

## CLI

```bash
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

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

옵션:

- `--channel`: `whatsapp` (기본값), `discord`, 또는 `msteams`
- `--poll-multi`: 여러 옵션을 선택하도록 허용
- `--poll-duration-hours`: Discord만 해당 (생략하면 기본값 24)

## Gateway RPC

메서드: `poll`

파라미터:

- `to` (문자열, 필수)
- `question` (문자열, 필수)
- `options` (문자열[], 필수)
- `maxSelections` (숫자, 선택)
- `durationHours` (숫자, 선택)
- `channel` (문자열, 선택, 기본값: `whatsapp`)
- `idempotencyKey` (문자열, 필수)

## 채널 차이

- WhatsApp: 2-12 옵션, `maxSelections`는 옵션 개수 내 있어야 함, `durationHours` 무시.
- Discord: 2-10 옵션, `durationHours`는 1-768시간으로 제한됨 (기본값 24). `maxSelections > 1`은 다중 선택을 활성화; Discord는 엄격한 선택 개수를 지원하지 않음.
- MS Teams: 적응형 카드 poll (OpenClaw 관리). 네이티브 poll API 없음; `durationHours` 무시.

## Agent 도구 (Message)

`poll` 액션 (`to`, `pollQuestion`, `pollOption`, 선택적 `pollMulti`, `pollDurationHours`, `channel`)과 함께 `message` 도구를 사용합니다.

메모: Discord는 "정확히 N 선택" 모드가 없습니다. `pollMulti`는 다중 선택으로 매핑됩니다.
Teams poll은 적응형 카드로 렌더링되며 Gateway가 온라인으로 투표를 기록하려면 `~/.openclaw/msteams-polls.json`에 온라인 상태를 유지해야 합니다.
