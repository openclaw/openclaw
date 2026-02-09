---
summary: "웨이크 워드와 푸시 투 토크가 겹칠 때의 음성 오버레이 라이프사이클"
read_when:
  - 음성 오버레이 동작을 조정할 때
title: "음성 오버레이"
---

# 음성 오버레이 라이프사이클 (macOS)

대상: macOS 앱 기여자. 목표: 웨이크 워드와 푸시 투 토크가 겹칠 때 음성 오버레이를 예측 가능하게 유지합니다.

## 현재 의도

- 웨이크 워드로 이미 오버레이가 표시된 상태에서 사용자가 핫키를 누르면, 핫키 세션은 텍스트를 초기화하지 않고 기존 텍스트를 _채택_합니다. 핫키를 누르고 있는 동안 오버레이는 유지됩니다. 사용자가 손을 떼면: 트리밍된 텍스트가 있으면 전송하고, 그렇지 않으면 닫습니다.
- 웨이크 워드만 사용하는 경우에는 침묵 시 자동 전송되며, 푸시 투 토크는 손을 떼는 즉시 전송합니다.

## 구현됨 (2025년 12월 9일)

- 오버레이 세션은 이제 캡처(웨이크 워드 또는 푸시 투 토크)마다 토큰을 보유합니다. 토큰이 일치하지 않으면 partial/final/send/dismiss/level 업데이트가 폐기되어, 오래된 콜백을 방지합니다.
- 푸시 투 토크는 표시 중인 모든 오버레이 텍스트를 접두사로 채택합니다(즉, 웨이크 오버레이가 떠 있는 동안 핫키를 누르면 텍스트를 유지한 채 새로운 음성을 이어 붙입니다). 최종 전사(final transcript)를 최대 1.5초까지 기다린 후, 실패 시 현재 텍스트로 대체합니다.
- 차임/오버레이 로깅은 `info`에서 카테고리 `voicewake.overlay`, `voicewake.ptt`, `voicewake.chime`로 출력됩니다(세션 시작, partial, final, 전송, 닫기, 차임 사유).

## 다음 단계

1. **VoiceSessionCoordinator (actor)**
   - 한 번에 정확히 하나의 `VoiceSession`만 소유합니다.
   - API (토큰 기반): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - 오래된 토큰을 포함한 콜백을 폐기합니다(이전 인식기가 오버레이를 다시 여는 것을 방지).
2. **VoiceSession (model)**
   - 필드: `token`, `source` (wakeWord|pushToTalk), 커밋/가변 텍스트, 차임 플래그, 타이머(자동 전송, 유휴), `overlayMode` (display|editing|sending), 쿨다운 마감 시각.
3. **오버레이 바인딩**
   - `VoiceSessionPublisher` (`ObservableObject`)가 활성 세션을 SwiftUI 로 미러링합니다.
   - `VoiceWakeOverlayView`은 퍼블리셔를 통해서만 렌더링하며, 전역 싱글턴을 직접 변경하지 않습니다.
   - 오버레이 사용자 동작(`sendNow`, `dismiss`, `edit`)은 세션 토큰과 함께 코디네이터로 콜백됩니다.
4. **통합 전송 경로**
   - `endCapture` 시점에: 트리밍된 텍스트가 비어 있으면 → 닫기; 그렇지 않으면 `performSend(session:)`(전송 차임을 한 번 재생, 전달, 닫기).
   - 푸시 투 토크: 지연 없음; 웨이크 워드: 자동 전송을 위한 선택적 지연.
   - 푸시 투 토크 종료 후 웨이크 런타임에 짧은 쿨다운을 적용하여, 웨이크 워드가 즉시 재트리거되지 않도록 합니다.
5. **로깅**
   - 코디네이터는 서브시스템 `bot.molt`, 카테고리 `voicewake.overlay` 및 `voicewake.chime`에서 `.info` 로그를 출력합니다.
   - 핵심 이벤트: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## 디버깅 체크리스트

- 끈적이는 오버레이를 재현하면서 로그를 스트리밍합니다:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 활성 세션 토큰이 하나뿐인지 확인합니다; 오래된 콜백은 코디네이터에서 폐기되어야 합니다.

- 푸시 투 토크 해제 시 항상 활성 토큰과 함께 `endCapture`를 호출하는지 확인합니다; 텍스트가 비어 있으면 차임이나 전송 없이 `dismiss`이 예상됩니다.

## 마이그레이션 단계 (권장)

1. `VoiceSessionCoordinator`, `VoiceSession`, `VoiceSessionPublisher`을 추가합니다.
2. `VoiceWakeRuntime`을 리팩터링하여 `VoiceWakeOverlayController`을 직접 건드리지 않고 세션을 생성/업데이트/종료하도록 합니다.
3. `VoicePushToTalk`를 리팩터링하여 기존 세션을 채택하고 해제 시 `endCapture`을 호출하도록 하며, 런타임 쿨다운을 적용합니다.
4. `VoiceWakeOverlayController`를 퍼블리셔에 연결하고, 런타임/PTT 에서의 직접 호출을 제거합니다.
5. 세션 채택, 쿨다운, 빈 텍스트 닫기에 대한 통합 테스트를 추가합니다.
