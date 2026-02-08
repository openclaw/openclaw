---
read_when:
    - 모든 채널에서 반응 작업
summary: 채널 전반에 걸쳐 공유되는 반응 의미
title: 반응
x-i18n:
    generated_at: "2026-02-08T16:13:37Z"
    model: gtx
    provider: google-translate
    source_hash: 0f11bff9adb4bd02604f96ebe2573a623702796732b6e17dfeda399cb7be0fa6
    source_path: tools/reactions.md
    workflow: 15
---

# 반응 도구

채널 전반에 걸쳐 공유된 반응 의미:

- `emoji` 반응을 추가할 때 필요합니다.
- `emoji=""` 지원되는 경우 봇의 반응을 제거합니다.
- `remove: true` 지원되는 경우 지정된 이모티콘을 제거합니다(필수 `emoji`).

채널 참고사항:

- **불일치/여유**: 비어 있는 `emoji` 메시지에 대한 봇의 반응을 모두 제거합니다. `remove: true` 해당 이모티콘만 제거합니다.
- **구글 채팅**: 비어 있는 `emoji` 메시지에 대한 앱의 반응을 제거합니다. `remove: true` 해당 이모티콘만 제거합니다.
- **전보**: 비어 있는 `emoji` 봇의 반응을 제거합니다. `remove: true` 반응도 제거하지만 여전히 비어 있지 않은 값이 필요합니다. `emoji` 도구 검증을 위해.
- **왓츠앱**: 비어 있는 `emoji` 봇 반응을 제거합니다. `remove: true` 빈 이모티콘에 매핑됩니다(여전히 필요함). `emoji`).
- **신호**: 인바운드 반응 알림은 다음과 같은 경우 시스템 이벤트를 발생시킵니다. `channels.signal.reactionNotifications` 활성화되었습니다.
