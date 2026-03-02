---
summary: "채널 간 공유되는 반응 시맨틱"
read_when:
  - 모든 채널에서 반응을 다룰 때
title: "반응"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/reactions.md
workflow: 15
---

# 반응 도구

채널 간 공유되는 반응 시맨틱:

- `emoji`는 반응을 추가할 때 필수입니다.
- `emoji=""`는 지원될 때 봇의 반응을 제거합니다.
- `remove: true`는 지원될 때 지정된 emoji를 제거합니다(`emoji` 필요).

채널 참고:

- **Discord/Slack**: 빈 `emoji`는 메시지의 봇의 모든 반응을 제거합니다; `remove: true`는 해당 emoji만 제거합니다.
- **Google Chat**: 빈 `emoji`는 앱의 반응을 메시지에서 제거합니다; `remove: true`는 해당 emoji만 제거합니다.
- **Telegram**: 빈 `emoji`는 봇 반응을 제거합니다; `remove: true`도 반응을 제거하지만 도구 검증을 위해 비어있지 않은 `emoji`가 필요합니다.
- **WhatsApp**: 빈 `emoji`는 봇 반응을 제거합니다; `remove: true`는 빈 emoji로 매핑됩니다(여전히 `emoji` 필요).
- **Signal**: `channels.signal.reactionNotifications`이 활성화되면 인바운드 반응 알림이 시스템 이벤트를 내보냅니다.
