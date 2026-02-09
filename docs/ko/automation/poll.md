---
summary: "Gateway(게이트웨이) + CLI 를 통한 설문 전송"
read_when:
  - 설문 지원을 추가하거나 수정할 때
  - CLI 또는 게이트웨이에서 설문 전송을 디버깅할 때
title: "설문"
---

# 설문

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

- `--channel`: `whatsapp` (기본값), `discord` 또는 `msteams`
- `--poll-multi`: 여러 옵션 선택 허용
- `--poll-duration-hours`: Discord 전용 (생략 시 기본값 24)

## Gateway RPC

메서드: `poll`

파라미터:

- `to` (string, 필수)
- `question` (string, 필수)
- `options` (string[], 필수)
- `maxSelections` (number, 선택)
- `durationHours` (number, 선택)
- `channel` (string, 선택, 기본값: `whatsapp`)
- `idempotencyKey` (string, 필수)

## 채널별 차이

- WhatsApp: 2-12 개 옵션, `maxSelections` 은 옵션 개수 범위 내여야 하며 `durationHours` 을 무시합니다.
- Discord: 2-10 개 옵션, `durationHours` 은 1-768 시간으로 제한됩니다 (기본값 24). `maxSelections > 1` 은 다중 선택을 활성화합니다. Discord 는 엄격한 선택 개수 제한을 지원하지 않습니다.
- MS Teams: Adaptive Card 설문 (OpenClaw 관리). 기본 설문 API 가 없으며 `durationHours` 은 무시됩니다.

## 에이전트 도구 (메시지)

`message` 도구를 `poll` 액션과 함께 사용합니다 (`to`, `pollQuestion`, `pollOption`, 선택 사항으로 `pollMulti`, `pollDurationHours`, `channel`).

참고: Discord 에는 ‘정확히 N 개 선택’ 모드가 없으며 `pollMulti` 는 다중 선택으로 매핑됩니다.
Teams 설문은 Adaptive Card 로 렌더링되며 `~/.openclaw/msteams-polls.json` 에서 투표를 기록하려면 Gateway(게이트웨이) 가 온라인 상태를 유지해야 합니다.
