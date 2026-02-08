---
read_when:
    - 음성 깨우기 동작 또는 기본값 변경
    - 깨우기 언어 동기화가 필요한 새로운 노드 플랫폼 추가
summary: 전역 음성 깨우기 단어(게이트웨이 소유) 및 노드 간 동기화 방법
title: 음성 웨이크
x-i18n:
    generated_at: "2026-02-08T15:58:44Z"
    model: gtx
    provider: google-translate
    source_hash: eb34f52dfcdc3fc1ae088ae1f621f245546d3cf388299fbeea62face61788c37
    source_path: nodes/voicewake.md
    workflow: 15
---

# 음성 깨우기(글로벌 깨우기 단어)

OpenClaw 취급 **단어를 단일 전역 목록으로 깨우기** 소유한 **게이트웨이**.

- 있다 **노드별 사용자 정의 깨우기 단어 없음**.
- **모든 노드/앱 UI를 편집할 수 있습니다.** 목록; 변경 사항은 게이트웨이에 의해 유지되고 모든 사람에게 브로드캐스트됩니다.
- 각 장치는 여전히 고유한 상태를 유지합니다. **음성 깨우기 활성화/비활성화** 토글(로컬 UX + 권한이 다름)

## 스토리지(게이트웨이 호스트)

깨우기 단어는 게이트웨이 시스템의 다음 위치에 저장됩니다.

- `~/.openclaw/settings/voicewake.json`

모양:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 규약

### 행동 양식

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` 매개변수 포함 `{ triggers: string[] }` → `{ triggers: string[] }`

참고:

- 트리거가 정규화됩니다(잘라내고 비어 있음). 빈 목록은 기본값으로 돌아갑니다.
- 안전을 위해 제한이 적용됩니다(개수/길이 제한).

### 이벤트

- `voicewake.changed` 유효 탑재량 `{ triggers: string[] }`

받는 사람:

- 모든 WebSocket 클라이언트(macOS 앱, WebChat 등)
- 연결된 모든 노드(iOS/Android) 및 노드의 초기 "현재 상태" 푸시로 연결됩니다.

## 클라이언트 행동

### macOS 앱

- 전역 목록을 사용하여 게이트합니다. `VoiceWakeRuntime` 트리거.
- 음성 깨우기 설정 통화에서 "트리거 단어" 편집 `voicewake.set` 그런 다음 브로드캐스트를 사용하여 다른 클라이언트의 동기화를 유지합니다.

### iOS 노드

- 다음에 대한 전역 목록을 사용합니다. `VoiceWakeManager` 트리거 감지.
- 설정 통화에서 깨우기 단어 편집 `voicewake.set` (Gateway WS를 통해) 또한 로컬 깨우기 단어 감지의 응답성을 유지합니다.

### 안드로이드 노드

- 설정에서 Wake Words 편집기를 노출합니다.
- 통화 `voicewake.set` Gateway WS를 통해 편집이 모든 곳에서 동기화됩니다.
