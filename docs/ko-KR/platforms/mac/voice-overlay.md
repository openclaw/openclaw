---
summary: "웨이크 단어와 푸시-투-톡이 겹칠 때 음성 오버레이 라이프사이클"
read_when:
  - 음성 오버레이 동작을 조정할 때
title: "음성 오버레이"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/voice-overlay.md"
  workflow: 15
---

# 음성 오버레이 라이프사이클 (macOS)

대상: macOS 앱 기여자. 목표: 웨이크 단어와 푸시-투-톡이 겹칠 때 음성 오버레이를 예측 가능하게 유지합니다.

## 현재 의도

- 오버레이가 이미 웨이크 단어에서 표시되고 있으며 사용자가 핫키를 누르면, 핫키 세션은 기존 텍스트를 _adopts_ 하여 재설정하는 대신입니다. 핫키가 유지될 동안 오버레이는 위로 유지됩니다. 사용자가 릴리스할 때: 단축된 텍스트가 있으면 보냅니다. 그렇지 않으면 해제합니다.
- 웨이크 단어만으로도 여전히 무음에서 자동 전송합니다. 푸시-투-톡은 릴리스 시 즉시 전송합니다.

## 구현됨 (12월 9, 2025)

- 오버레이 세션은 이제 캡처별 토큰을 운반합니다 (웨이크 단어 또는 푸시-투-톡). Partial/final/send/dismiss/level 업데이트는 토큰이 일치하지 않으면 삭제되며, 오래된 콜백을 방지합니다.
- 푸시-투-톡은 표시된 오버레이 텍스트를 접두사로 채택합니다 (핫키를 눌 때 웨이크 오버레이는 텍스트를 유지하고 새 음성을 추가합니다). 최종 기록이 떨어질 때까지 1.5초를 기다립니다. 그렇지 않으면 현재 텍스트로 폴백합니다.
- Chime/오버레이 로깅은 `info` in 카테고리 `voicewake.overlay`, `voicewake.ptt`, and `voicewake.chime`에서 발출됩니다 (세션 시작, partial, final, send, dismiss, chime 이유).

## 다음 단계

1. **VoiceSessionCoordinator (actor)**
   - 정확히 하나의 `VoiceSession`을 한 번에 소유합니다.
   - API (토큰 기반): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - 오래된 토큰을 운반하는 콜백을 삭제합니다 (이전 인식기가 오버레이를 다시 열지 않도록 방지).
2. **VoiceSession (모델)**
   - 필드: `token`, `source` (wakeWord|pushToTalk), committed/volatile 텍스트, chime 플래그, 타이머 (자동 전송, 유휴), `overlayMode` (display|editing|sending), cooldown 마감 시간.
3. **오버레이 바인딩**
   - `VoiceSessionPublisher` (`ObservableObject`)는 활성 세션을 SwiftUI로 미러링합니다.
   - `VoiceWakeOverlayView`는 게시자를 통해서만 렌더링합니다. 전역 싱글톤을 직접 변경하지 않습니다.
   - 오버레이 사용자 작업 (`sendNow`, `dismiss`, `edit`)은 세션 토큰을 사용하여 코디네이터로 콜백합니다.
4. **통합 전송 경로**
   - `endCapture`에서: 단축된 텍스트가 비어 있으면 → 해제; 그렇지 않으면 `performSend(session:)` (한 번 전송 chime을 재생하고, 포워드, 해제).
   - 푸시-투-톡: 지연 없음. 웨이크 단어: 자동 전송에 대한 선택적 지연.
   - 푸시-투-톡이 끝난 후 웨이크 런타임에 짧은 쿨다운을 적용하여 웨이크 단어가 즉시 재트리거되지 않도록 합니다.
5. **로깅**
   - 코디네이터는 `.info` 로그를 서브시스템 `ai.openclaw`, 카테고리 `voicewake.overlay` 및 `voicewake.chime`에서 발출합니다.
   - 주요 이벤트: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## 디버깅 체크리스트

- 고착된 오버레이를 재현하는 동안 로그를 스트림합니다:

  ```bash
  sudo log stream --predicate 'subsystem == "ai.openclaw" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 활성 세션 토큰이 하나만 있는지 확인합니다. 오래된 콜백은 코디네이터에서 삭제되어야 합니다.
- 푸시-투-톡 릴리스가 항상 활성 토큰으로 `endCapture`를 호출하는지 확인합니다. 텍스트가 비어 있으면 chime이나 전송 없이 `dismiss`를 예상합니다.

## 마이그레이션 단계 (제안됨)

1. `VoiceSessionCoordinator`, `VoiceSession`, 및 `VoiceSessionPublisher`를 추가합니다.
2. `VoiceWakeRuntime`을 리팩터하여 `VoiceWakeOverlayController`를 직접 터치하는 대신 세션을 생성/업데이트/종료합니다.
3. `VoicePushToTalk`를 리팩터하여 기존 세션을 채택하고 릴리스에서 `endCapture`를 호출합니다. 런타임 쿨다운을 적용합니다.
4. `VoiceWakeOverlayController`를 게시자로 연결합니다. 런타임/PTT에서 직접 호출을 제거합니다.
5. 세션 채택, 쿨다운, 및 빈 텍스트 해제에 대한 통합 테스트를 추가합니다.
