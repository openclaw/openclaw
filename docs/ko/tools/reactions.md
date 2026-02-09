---
summary: "채널 전반에 걸쳐 공유되는 리액션 의미 체계"
read_when:
  - 모든 채널에서 리액션 작업을 할 때
title: "리액션"
---

# 리액션 도구

채널 전반에 걸쳐 공유되는 리액션 의미 체계:

- 리액션을 추가할 때 `emoji` 가 필요합니다.
- `emoji=""` 는 지원되는 경우 봇의 리액션을 제거합니다.
- `remove: true` 는 지원되는 경우 지정된 이모지를 제거합니다 (`emoji` 필요).

채널별 참고 사항:

- **Discord/Slack**: 비어 있는 `emoji` 는 메시지에서 봇의 모든 리액션을 제거합니다; `remove: true` 는 해당 이모지만 제거합니다.
- **Google Chat**: 비어 있는 `emoji` 는 메시지에서 앱의 리액션을 제거합니다; `remove: true` 는 해당 이모지만 제거합니다.
- **Telegram**: 비어 있는 `emoji` 는 봇의 리액션을 제거합니다; `remove: true` 또한 리액션을 제거하지만, 도구 검증을 위해 비어 있지 않은 `emoji` 이 여전히 필요합니다.
- **WhatsApp**: 비어 있는 `emoji` 는 봇 리액션을 제거합니다; `remove: true` 는 빈 이모지로 매핑됩니다 (`emoji` 는 여전히 필요).
- **Signal**: `channels.signal.reactionNotifications` 가 활성화되면 수신 리액션 알림이 시스템 이벤트를 발생시킵니다.
