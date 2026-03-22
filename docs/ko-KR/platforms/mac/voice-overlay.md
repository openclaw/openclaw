---
summary: "웨이크 워드와 푸시 투 토크가 겹칠 때의 음성 오버레이 라이프사이클"
read_when:
  - 음성 오버레이 동작을 조정할 때
title: "음성 오버레이"
x-i18n:
  source_path: docs/platforms/mac/voice-overlay.md
---

# 음성 오버레이 라이프사이클 (macOS)

대상: macOS 앱 기여자. 목표: 웨이크 워드와 푸시 투 토크가 겹칠 때 음성 오버레이를 예측 가능하게 유지합니다.

## 현재 의도

- 웨이크 워드에서 오버레이가 이미 보이는 상태에서 사용자가 핫키를 누르면, 핫키 세션이 기존 텍스트를 초기화하지 않고 *채택*합니다. 핫키를 누르고 있는 동안 오버레이가 유지됩니다. 사용자가 놓으면: 트리밍된 텍스트가 있으면 전송, 없으면 닫기.
- 웨이크 워드만으로도 침묵 시 자동 전송; 푸시 투 토크는 놓을 때 즉시 전송.

## 구현 완료 (2025 년 12 월 9 일)

- 오버레이 세션은 이제 캡처 (웨이크 워드 또는 푸시 투 토크) 마다 토큰을 가집니다. 토큰이 일치하지 않으면 부분/최종/전송/닫기/레벨 업데이트가 삭제되어 오래된 콜백을 방지합니다.
- 푸시 투 토크는 보이는 오버레이 텍스트를 접두어로 채택합니다 (따라서 웨이크 오버레이가 켜져 있는 동안 핫키를 누르면 텍스트를 유지하고 새 음성을 추가). 최종 트랜스크립트를 위해 최대 1.5 초까지 기다린 후 현재 텍스트로 폴백합니다.
- 차임/오버레이 로깅은 `voicewake.overlay`, `voicewake.ptt`, `voicewake.chime` 카테고리에서 `info` 레벨로 출력됩니다 (세션 시작, 부분, 최종, 전송, 닫기, 차임 이유).

## 다음 단계

1. **VoiceSessionCoordinator (actor)**
   - 한 번에 정확히 하나의 `VoiceSession` 을 소유합니다.
   - API (토큰 기반): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - 오래된 토큰을 가진 콜백을 삭제합니다 (이전 인식기가 오버레이를 다시 여는 것을 방지).
2. **VoiceSession (모델)**
   - 필드: `token`, `source` (wakeWord|pushToTalk), committed/volatile 텍스트, 차임 플래그, 타이머 (자동 전송, 유휴), `overlayMode` (display|editing|sending), 쿨다운 데드라인.
3. **오버레이 바인딩**
   - `VoiceSessionPublisher` (`ObservableObject`) 는 활성 세션을 SwiftUI 로 미러링합니다.
   - `VoiceWakeOverlayView` 는 퍼블리셔를 통해서만 렌더링합니다; 글로벌 싱글턴을 직접 변경하지 않습니다.
   - 오버레이 사용자 작업 (`sendNow`, `dismiss`, `edit`) 은 세션 토큰과 함께 코디네이터로 콜백합니다.
4. **통합 전송 경로**
   - `endCapture` 시: 트리밍된 텍스트가 비어 있으면 → 닫기; 아니면 `performSend(session:)` (전송 차임을 한 번 재생, 전달, 닫기).
   - 푸시 투 토크: 지연 없음; 웨이크 워드: 자동 전송을 위한 선택적 지연.
   - 푸시 투 토크 완료 후 웨이크 런타임에 짧은 쿨다운을 적용하여 웨이크 워드가 즉시 재트리거되지 않도록 합니다.
5. **로깅**
   - 코디네이터는 서브시스템 `ai.openclaw`, 카테고리 `voicewake.overlay` 와 `voicewake.chime` 에서 `.info` 로그를 출력합니다.
   - 주요 이벤트: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## 디버깅 체크리스트

- 고정 오버레이를 재현하면서 로그를 스트리밍합니다:

  ```bash
  sudo log stream --predicate 'subsystem == "ai.openclaw" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 활성 세션 토큰이 하나만 있는지 확인; 오래된 콜백은 코디네이터에 의해 삭제되어야 합니다.
- 푸시 투 토크 놓기가 항상 활성 토큰으로 `endCapture` 를 호출하는지 확인; 텍스트가 비어 있으면 차임이나 전송 없이 `dismiss` 가 예상됩니다.

## 마이그레이션 단계 (제안)

1. `VoiceSessionCoordinator`, `VoiceSession`, `VoiceSessionPublisher` 를 추가합니다.
2. `VoiceWakeRuntime` 을 리팩토링하여 `VoiceWakeOverlayController` 를 직접 터치하는 대신 세션을 생성/업데이트/종료합니다.
3. `VoicePushToTalk` 를 리팩토링하여 기존 세션을 채택하고 놓을 때 `endCapture` 를 호출합니다; 런타임 쿨다운을 적용합니다.
4. `VoiceWakeOverlayController` 를 퍼블리셔에 연결합니다; 런타임/PTT 에서의 직접 호출을 제거합니다.
5. 세션 채택, 쿨다운, 빈 텍스트 닫기에 대한 통합 테스트를 추가합니다.
