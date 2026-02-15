---
summary: "Global voice wake words (Gateway-owned) and how they sync across nodes"
read_when:
  - Changing voice wake words behavior or defaults
  - Adding new node platforms that need wake word sync
title: "Voice Wake"
x-i18n:
  source_hash: eb34f52dfcdc3fc1ae088ae1f621f245546d3cf388299fbeea62face61788c37
---

# 음성 깨우기(글로벌 깨우기 단어)

OpenClaw는 **깨우기 단어를 **게이트웨이**가 소유한 단일 전역 목록**으로 처리합니다.

- **노드별 사용자 정의 깨우기 단어**가 없습니다.
- **모든 노드/앱 UI에서 목록을 편집**할 수 있습니다. 변경 사항은 게이트웨이에 의해 유지되고 모든 사람에게 브로드캐스트됩니다.
- 각 장치는 여전히 자체 **Voice Wake 활성화/비활성화** 토글을 유지합니다(로컬 UX + 권한은 다름).

## 스토리지(게이트웨이 호스트)

깨우기 단어는 게이트웨이 시스템의 다음 위치에 저장됩니다.

- `~/.openclaw/settings/voicewake.json`

모양:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 프로토콜

### 방법

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` 매개변수 `{ triggers: string[] }` → `{ triggers: string[] }`

참고:

- 트리거가 정규화되었습니다(잘라내기, 빈 항목 삭제). 빈 목록은 기본값으로 돌아갑니다.
- 안전을 위해 제한이 적용됩니다(개수/길이 제한).

### 이벤트

- `voicewake.changed` 페이로드 `{ triggers: string[] }`

받는 사람:

- 모든 WebSocket 클라이언트(macOS 앱, WebChat 등)
- 연결된 모든 노드(iOS/Android) 및 노드의 초기 "현재 상태" 푸시로 연결됩니다.

## 클라이언트 행동

### macOS 앱

- 전역 목록을 사용하여 `VoiceWakeRuntime` 트리거를 게이트합니다.
- 음성 깨우기 설정에서 "트리거 단어"를 편집하면 `voicewake.set`이 호출되고 방송에 의존하여 다른 클라이언트의 동기화를 유지합니다.

### iOS 노드

- `VoiceWakeManager` 트리거 감지를 위해 전역 목록을 사용합니다.
- 설정에서 깨우기 단어를 편집하면 `voicewake.set`(게이트웨이 WS를 통해)가 호출되고 로컬 깨우기 단어 감지 응답도 유지됩니다.

### 안드로이드 노드

- 설정에서 Wake Words 편집기를 노출합니다.
- 게이트웨이 WS를 통해 `voicewake.set`를 호출하므로 모든 곳에서 동기화를 편집합니다.
