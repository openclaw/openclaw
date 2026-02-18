---
summary: "게이트웨이 + CLI를 통한 투표 전송"
read_when:
  - 투표 지원을 추가하거나 수정할 때
  - CLI 또는 게이트웨이에서 투표 전송을 디버깅할 때
title: "투표"
---

# 투표

## 지원되는 채널

- WhatsApp (웹 채널)
- Discord
- MS Teams (Adaptive Cards)

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
- `--poll-multi`: 여러 옵션 선택 허용
- `--poll-duration-hours`: Discord 전용 (명시하지 않을 경우 기본값 24)

## Gateway RPC

메서드: `poll`

매개변수:

- `to` (string, 필수)
- `question` (string, 필수)
- `options` (string[], 필수)
- `maxSelections` (number, 선택)
- `durationHours` (number, 선택)
- `channel` (string, 선택, 기본값: `whatsapp`)
- `idempotencyKey` (string, 필수)

## 채널 차이

- WhatsApp: 2-12 옵션, `maxSelections`는 옵션 수 내에서 지정해야 하며, `durationHours`는 무시됩니다.
- Discord: 2-10 옵션, `durationHours`는 1-768 시간으로 제한 (기본값 24). `maxSelections > 1`은 다중 선택을 활성화합니다; Discord는 엄격한 선택 수를 지원하지 않습니다.
- MS Teams: Adaptive Card 투표 (OpenClaw 관리). 네이티브 투표 API가 없으며, `durationHours`는 무시됩니다.

## 에이전트 도구 (메시지)

`message` 도구를 `poll` 액션과 함께 사용합니다 (`to`, `pollQuestion`, `pollOption`, 선택적 `pollMulti`, `pollDurationHours`, `channel`).

참고: Discord는 "정확히 N개를 선택" 모드를 지원하지 않습니다; `pollMulti`는 다중 선택으로 매핑됩니다.
Teams 투표는 Adaptive Cards로 렌더링되며 투표 기록을 위해 게이트웨이가 온라인 상태를 유지해야 합니다
`~/.openclaw/msteams-polls.json`에 기록됩니다.
