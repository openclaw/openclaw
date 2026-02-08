---
read_when:
    - 설문 조사 지원 추가 또는 수정
    - CLI 또는 게이트웨이에서 폴링 전송 디버깅
summary: 게이트웨이 + CLI를 통한 폴링 전송
title: 투표소
x-i18n:
    generated_at: "2026-02-08T15:45:59Z"
    model: gtx
    provider: google-translate
    source_hash: 760339865d27ec40def7996cac1d294d58ab580748ad6b32cc34d285d0314eaf
    source_path: automation/poll.md
    workflow: 15
---

# 투표소

## 지원되는 채널

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

- `--channel`: `whatsapp` (기본), `discord`, 또는 `msteams`
- `--poll-multi`: 여러 옵션 선택 가능
- `--poll-duration-hours`: 디스코드 전용 (생략시 기본값은 24)

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

- WhatsApp: 2-12가지 옵션, `maxSelections` 옵션 수 내에 있어야 하며 무시합니다. `durationHours`.
- 불일치: 2-10개 옵션, `durationHours` 1~768시간(기본값 24)으로 고정됩니다. `maxSelections > 1` 다중 선택이 가능합니다. Discord는 엄격한 선택 횟수를 지원하지 않습니다.
- MS Teams: 적응형 카드 설문 조사(OpenClaw 관리). 기본 설문조사 API가 없습니다. `durationHours` 무시됩니다.

## 에이전트 도구(메시지)

사용 `message` 도구 `poll` 행동 (`to`, `pollQuestion`, `pollOption`, 선택사항 `pollMulti`, `pollDurationHours`, `channel`).

참고: Discord에는 "정확히 N 선택" 모드가 없습니다. `pollMulti` 다중 선택에 매핑됩니다.
Teams 설문조사는 적응형 카드로 렌더링되며 온라인 상태를 유지하려면 게이트웨이가 필요합니다.
투표를 기록하다 `~/.openclaw/msteams-polls.json`.
