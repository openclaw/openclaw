---
summary: "Reaction semantics shared across channels"
read_when:
  - Working on reactions in any channel
title: "Reactions"
x-i18n:
  source_hash: 0f11bff9adb4bd02604f96ebe2573a623702796732b6e17dfeda399cb7be0fa6
---

# 반응 도구

채널 전반에 걸쳐 공유된 반응 의미:

- 반응 추가 시 `emoji`가 필요합니다.
- `emoji=""`는 지원되는 경우 봇의 반응을 제거합니다.
- `remove: true`는 지원되는 경우 지정된 이모티콘을 제거합니다(`emoji` 필요).

채널 참고사항:

- **Discord/Slack**: 비어 있는 `emoji`는 메시지에 대한 봇의 모든 반응을 제거합니다. `remove: true`는 해당 이모티콘만 제거합니다.
- **Google Chat**: 비어 있는 `emoji`는 메시지에 대한 앱의 반응을 제거합니다. `remove: true` 해당 이모티콘만 제거합니다.
- **텔레그램**: 비어 있는 `emoji`는 봇의 반응을 제거합니다. `remove: true`도 반응을 제거하지만 도구 검증을 위해 여전히 비어 있지 않은 `emoji`가 필요합니다.
- **WhatsApp**: 비어 있는 `emoji`는 봇 반응을 제거합니다. `remove: true`는 빈 이모티콘에 매핑됩니다(여전히 `emoji` 필요).
- **신호**: `channels.signal.reactionNotifications`가 활성화되면 수신 반응 알림이 시스템 이벤트를 발생시킵니다.
