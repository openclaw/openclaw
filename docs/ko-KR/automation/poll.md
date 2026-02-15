---
summary: "Poll sending via gateway + CLI"
read_when:
  - Adding or modifying poll support
  - Debugging poll sends from the CLI or gateway
title: "Polls"
x-i18n:
  source_hash: 760339865d27ec40def7996cac1d294d58ab580748ad6b32cc34d285d0314eaf
---

# 여론조사

## 지원 채널

- WhatsApp(웹 채널)
- 불화
- MS Teams(적응형 카드)

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
- `--poll-duration-hours` : 디스코드 전용 (생략시 기본값은 24)

## 게이트웨이 RPC

방법: `poll`

매개변수:

- `to` (문자열, 필수)
- `question` (문자열, 필수)
- `options` (문자열[], 필수)
- `maxSelections` (숫자, 선택사항)
- `durationHours` (숫자, 선택사항)
- `channel` (문자열, 선택 사항, 기본값: `whatsapp`)
- `idempotencyKey` (문자열, 필수)

## 채널 차이

- WhatsApp: 2-12개의 옵션, `maxSelections`는 옵션 개수 내에 있어야 하며 `durationHours`를 무시합니다.
- Discord: 2~10개 옵션, `durationHours`는 1~768시간(기본값 24)으로 고정됩니다. `maxSelections > 1`는 다중 선택을 활성화합니다. Discord는 엄격한 선택 횟수를 지원하지 않습니다.
- MS Teams: 적응형 카드 설문 조사(OpenClaw 관리). 기본 설문조사 API가 없습니다. `durationHours`은 무시됩니다.

## 에이전트 도구(메시지)

`message` 도구를 `poll` 작업과 함께 사용합니다. (`to`, `pollQuestion`, `pollOption`, 선택 사항 `pollMulti`, `pollDurationHours`, `channel`).

참고: Discord에는 "정확히 N 선택" 모드가 없습니다. `pollMulti`는 다중 선택에 매핑됩니다.
Teams 설문조사는 적응형 카드로 렌더링되며 온라인 상태를 유지하려면 게이트웨이가 필요합니다.
`~/.openclaw/msteams-polls.json`에 투표를 기록합니다.
