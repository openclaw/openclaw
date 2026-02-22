---
summary: "채널 전반에 걸친 반응 의미론"
read_when:
  - 모든 채널에서 반응 작업을 할 때
title: "반응"
---

# 반응 도구

채널 전반에 걸친 공유 반응 의미론:

- `emoji`는 반응을 추가할 때 필수입니다.
- `emoji=""`는 지원되는 경우 봇의 반응을 제거합니다.
- `remove: true`는 지원되는 경우 지정된 이모지를 제거합니다 (`emoji`가 필요).

채널 주의사항:

- **Discord/Slack**: 빈 `emoji`는 메시지에서 봇의 모든 반응을 제거합니다. `remove: true`는 그 이모지만 제거합니다.
- **Google Chat**: 빈 `emoji`는 메시지에서 앱의 반응을 제거합니다. `remove: true`는 그 이모지만 제거합니다.
- **Telegram**: 빈 `emoji`는 봇의 반응을 제거합니다. `remove: true`는 또한 반응을 제거하지만 도구 유효성을 위해 여전히 비어 있지 않은 `emoji`가 필요합니다.
- **WhatsApp**: 빈 `emoji`는 봇의 반응을 제거합니다. `remove: true`는 빈 이모지로 매핑됩니다 (여전히 `emoji`가 필요).
- **Signal**: `channels.signal.reactionNotifications`가 활성화되어 있으면 들어오는 반응 알림이 시스템 이벤트를 발생시킵니다.
