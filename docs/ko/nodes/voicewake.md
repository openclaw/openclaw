---
summary: "Gateway(게이트웨이) 소유의 전역 음성 웨이크 워드와 노드 간 동기화 방식"
read_when:
  - 음성 웨이크 워드의 동작이나 기본값을 변경할 때
  - 웨이크 워드 동기화가 필요한 새로운 노드 플랫폼을 추가할 때
title: "Voice Wake"
---

# Voice Wake (전역 웨이크 워드)

OpenClaw 는 **웨이크 워드를 Gateway(게이트웨이)** 가 소유하는 **단일 전역 목록**으로 취급합니다.

- 13. **노드별 사용자 정의 웨이크 워드는 없습니다**.
- **어떤 노드/앱 UI 에서든 목록을 편집**할 수 있으며, 변경 사항은 Gateway(게이트웨이)에 의해 저장되고 모두에게 브로드캐스트됩니다.
- 각 디바이스는 여전히 자체적인 **Voice Wake 활성화/비활성화** 토글을 유지합니다(로컬 UX 와 권한은 서로 다릅니다).

## 저장소 (Gateway 호스트)

웨이크 워드는 Gateway(게이트웨이) 머신에 다음 위치로 저장됩니다:

- `~/.openclaw/settings/voicewake.json`

형식:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 프로토콜

### 메서드

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` (params: `{ triggers: string[] }`) → `{ triggers: string[] }`

참고:

- 트리거는 정규화됩니다(앞뒤 공백 제거, 빈 항목 제거). 빈 목록인 경우 기본값으로 되돌아갑니다.
- 안전을 위해 제한 사항이 적용됩니다(개수/길이 제한).

### 이벤트

- `voicewake.changed` 페이로드 `{ triggers: string[] }`

14. 수신 대상:

- 모든 WebSocket 클라이언트(macOS 앱, WebChat 등)
- 연결된 모든 노드(iOS/Android), 또한 노드 연결 시 초기 '현재 상태' 푸시로도 전송됩니다.

## 클라이언트 동작

### macOS 앱

- 전역 목록을 사용하여 `VoiceWakeRuntime` 트리거를 제어합니다.
- Voice Wake 설정에서 'Trigger words' 를 편집하면 `voicewake.set` 을 호출하고, 이후 브로드캐스트에 의존하여 다른 클라이언트와의 동기화를 유지합니다.

### iOS 노드

- 전역 목록을 사용하여 `VoiceWakeManager` 트리거 감지를 수행합니다.
- 설정에서 Wake Words 를 편집하면 `voicewake.set` 를 호출하며(Gateway WS 경유), 로컬 웨이크 워드 감지도 반응성을 유지합니다.

### Android 노드

- 설정에서 Wake Words 편집기를 제공합니다.
- Gateway WS 를 통해 `voicewake.set` 을 호출하여 편집 내용이 전체에 동기화되도록 합니다.
