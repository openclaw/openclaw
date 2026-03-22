---
summary: "모든 지원 채널에서의 리액션 도구 의미론"
read_when:
  - 어떤 채널에서든 리액션 작업을 할 때
  - 플랫폼 간 이모지 리액션이 어떻게 다른지 이해할 때
title: "리액션"
x-i18n:
  source_path: docs/tools/reactions.md
---

# 리액션

에이전트는 `react` 액션과 함께 `message` 도구를 사용하여 메시지에 이모지 리액션을 추가하거나 제거할 수 있습니다. 리액션 동작은 채널에 따라 다릅니다.

## 작동 방식

```json
{
  "action": "react",
  "messageId": "msg-123",
  "emoji": "thumbsup"
}
```

- `emoji`는 리액션을 추가할 때 필수입니다.
- 봇의 리액션을 제거하려면 `emoji`를 빈 문자열 (`""`) 로 설정합니다.
- 특정 이모지를 제거하려면 `remove: true`로 설정합니다 (비어 있지 않은 `emoji` 필요).

## 채널별 동작

<AccordionGroup>
  <Accordion title="Discord 및 Slack">
    - 빈 `emoji`는 메시지에서 봇의 모든 리액션을 제거합니다.
    - `remove: true`는 지정된 이모지만 제거합니다.
  </Accordion>

  <Accordion title="Google Chat">
    - 빈 `emoji`는 메시지에서 앱의 리액션을 제거합니다.
    - `remove: true`는 지정된 이모지만 제거합니다.
  </Accordion>

  <Accordion title="Telegram">
    - 빈 `emoji`는 봇의 리액션을 제거합니다.
    - `remove: true`도 리액션을 제거하지만 도구 유효성 검사를 위해 비어 있지 않은 `emoji`가 여전히 필요합니다.
  </Accordion>

  <Accordion title="WhatsApp">
    - 빈 `emoji`는 봇 리액션을 제거합니다.
    - `remove: true`는 내부적으로 빈 이모지에 매핑됩니다 (도구 호출에서 `emoji`가 여전히 필요).
  </Accordion>

  <Accordion title="Zalo Personal (zalouser)">
    - 비어 있지 않은 `emoji`가 필요합니다.
    - `remove: true`는 특정 이모지 리액션을 제거합니다.
  </Accordion>

  <Accordion title="Signal">
    - `channels.signal.reactionNotifications`가 활성화된 경우 인바운드 리액션 알림이 시스템 이벤트를 발생시킵니다.
  </Accordion>
</AccordionGroup>

## 관련 문서

- [Agent Send](/tools/agent-send) — `react`를 포함하는 `message` 도구
- [채널](/channels) — 채널별 구성
