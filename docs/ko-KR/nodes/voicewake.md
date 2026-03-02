---
summary: "전역 음성 wake 단어(Gateway 소유) 및 노드 간 동기화 방식"
read_when:
  - 음성 wake 단어 동작 또는 기본값을 변경할 때
  - wake 단어 동기화가 필요한 새 노드 플랫폼을 추가할 때
title: "음성 Wake"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/voicewake.md
workflow: 15
---

# 음성 Wake(전역 Wake 단어)

OpenClaw는 **wake 단어를 단일 전역 목록**으로 취급합니다. **Gateway**가 소유합니다.

- **노드별 커스텀 wake 단어는 없습니다**.
- **모든 노드/앱 UI는 목록을 편집**할 수 있습니다; 변경사항은 Gateway에 의해 유지되고 모두에게 브로드캐스트됩니다.
- 각 장치는 여전히 **Voice Wake enabled/disabled** 전환을 유지합니다(로컬 UX + 권한이 다름).

## 저장소(Gateway 호스트)

Wake 단어는 Gateway 머신에 저장됩니다:

- `~/.openclaw/settings/voicewake.json`

모양:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 프로토콜

### 메서드

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set`과 함께 파라미터 `{ triggers: string[] }` → `{ triggers: string[] }`

참고:

- 트리거는 정규화됩니다(자르기, 비우기 삭제). 빈 목록은 기본값으로 돌아갑니다.
- 안전성을 위해 한계가 적용됩니다(개수/길이 상한).

### 이벤트

- `voicewake.changed` 페이로드 `{ triggers: string[] }`

받는 사람:

- 모든 WebSocket 클라이언트(macOS 앱, WebChat 등)
- 모든 연결된 노드(iOS/Android), 그리고 노드 연결 시 초기 "current state" 푸시.

## 클라이언트 동작

### macOS 앱

- 전역 목록을 사용하여 `VoiceWakeRuntime` 트리거를 제어합니다.
- Voice Wake 설정에서 "Trigger words" 편집은 `voicewake.set`을 호출하고 브로드캐스트에 의존하여 다른 클라이언트를 동기화된 상태로 유지합니다.

### iOS 노드

- `VoiceWakeManager` 트리거 감지를 위해 전역 목록을 사용합니다.
- Settings에서 Wake Words 편집은 Gateway WS에서 `voicewake.set`을 호출하고 로컬 wake 단어 감지도 반응성 있게 유지합니다.

### Android 노드

- Settings에서 Wake Words 편집기를 노출합니다.
- 편집이 모든 곳에 동기화되도록 Gateway WS에서 `voicewake.set`을 호출합니다.
