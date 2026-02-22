---
summary: "글로벌 음성 인식 호출어 (게이트웨이 소유)와 노드 간 동기화 방법"
read_when:
  - 음성 인식 호출어 동작 또는 기본값 변경
  - 호출어 동기화가 필요한 새로운 노드 플랫폼 추가
title: "음성 인식 호출"
---

# 음성 인식 호출 (글로벌 호출어)

OpenClaw는 **음성 인식 호출어를 게이트웨이가 소유한 단일 글로벌 목록**으로 처리합니다.

- **노드별 사용자 정의 호출어는 없습니다.**
- **모든 노드/앱 UI에서** 목록을 편집할 수 있으며, 변경 사항은 게이트웨이에 의해 저장되고 모든 사용자에게 방송됩니다.
- 각 장치는 여전히 자신의 **Voice Wake 활성화/비활성화** 토글을 유지합니다 (로컬 UX + 권한은 다를 수 있음).

## 저장소 (게이트웨이 호스트)

호출어는 게이트웨이 머신에 다음과 같이 저장됩니다:

- `~/.openclaw/settings/voicewake.json`

형식:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 프로토콜

### 메소드

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` with params `{ triggers: string[] }` → `{ triggers: string[] }`

주의사항:

- 트리거는 정규화됩니다 (공백 제거, 빈 항목 삭제). 빈 목록은 기본값으로 돌아갑니다.
- 안전을 위해 제한이 적용됩니다 (개수/길이 제한).

### 이벤트

- `voicewake.changed` payload `{ triggers: string[] }`

수신 대상:

- 모든 WebSocket 클라이언트 (macOS 앱, WebChat 등)
- 모든 연결된 노드 (iOS/Android), 또한 노드 연결 시 초기 "현재 상태" 푸시

## 클라이언트 동작

### macOS 앱

- `VoiceWakeRuntime` 트리거를 제어하기 위해 글로벌 목록을 사용합니다.
- 음성 인식 설정에서 "트리거 단어" 편집은 `voicewake.set`을 호출하고 다른 클라이언트와의 동기화를 위해 방송에 의존합니다.

### iOS 노드

- `VoiceWakeManager` 트리거 감지를 위해 글로벌 목록을 사용합니다.
- 설정에서 호출어 편집은 게이트웨이 WS를 통해 `voicewake.set`을 호출하고 로컬 호출어 감지를 반응형으로 유지합니다.

### Android 노드

- 설정에서 호출어 편집기를 제공합니다.
- 게이트웨이 WS를 통해 `voicewake.set`을 호출하여 편집 내용을 모든 곳에 동기화합니다.
