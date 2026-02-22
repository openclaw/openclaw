---
summary: "wake-word 및 push-to-talk 이 중첩될 때의 음성 오버레이 수명 주기"
read_when:
  - 음성 오버레이 동작 조정
title: "Voice Overlay"
---

# Voice Overlay 수명 주기 (macOS)

대상: macOS 앱 기여자. 목표: wake-word와 push-to-talk이 중첩될 때 음성 오버레이의 예측 가능성을 유지합니다.

## 현재 목표

- 오버레이가 이미 wake-word로 인해 보이는 경우 사용자가 핫키를 누르면 핫키 세션이 기존 텍스트를 재설정하지 않고 _채택_ 합니다. 핫키를 누르는 동안 오버레이는 그대로 유지됩니다. 사용자가 놓을 때: 텍스트가 다듬어져 있으면 보냅니다, 그렇지 않으면 닫습니다.
- wake-word 단독으로는 여전히 무음 상태에서 자동 전송되고, push-to-talk은 놓으면 즉시 전송됩니다.

## 구현됨 (2025년 12월 9일)

- 오버레이 세션은 이제 캡처(화면 또는 push-to-talk)마다 토큰을 유지합니다. 토큰이 일치하지 않는 경우 부분/최종/전송/취소/수준 업데이트가 드롭되어 오래된 콜백을 방지합니다.
- push-to-talk은 보이는 오버레이 텍스트를 접두사로 채택합니다(따라서 wake 오버레이가 활성화된 동안 핫키를 누르면 텍스트를 유지하고 새로운 음성을 추가합니다). 현재 텍스트로 되돌아가기 전에 최대 1.5초 동안 최종 성적표를 기다립니다.
- `voicewake.overlay`, `voicewake.ptt`, `voicewake.chime` 범주의 `info`에서 chime/오버레이 로그가 발신됩니다 (세션 시작, 부분, 최종, 전송, 취소, chime 이유).

## 다음 단계

1. **VoiceSessionCoordinator (actor)**
   - 한 번에 정확히 하나의 `VoiceSession`을 소유합니다.
   - API (토큰 기반): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - 오래된 토큰을 포함하는 콜백을 드롭합니다 (오래된 인식기가 오버레이를 다시 여는 것을 방지합니다).
2. **VoiceSession (model)**
   - 필드: `token`, `source` (wakeWord|pushToTalk), 커밋된/불안정 텍스트, chime 플래그, 타이머 (자동 전송, 대기), `overlayMode` (디스플레이|편집|전송 중), 쿨다운 기한.
3. **오버레이 바인딩**
   - `VoiceSessionPublisher` (`ObservableObject`)가 활성 세션을 SwiftUI로 반영합니다.
   - `VoiceWakeOverlayView`는 게시자만 통해 렌더링됩니다; 전역 싱글톤을 직접 변형하지 않습니다.
   - 오버레이 사용자 행동 (`sendNow`, `dismiss`, `edit`)은 세션 토큰과 함께 코디네이터로 다시 호출됩니다.
4. **통합 전송 경로**
   - `endCapture`에서: 다듬어진 텍스트가 비어 있으면 → 닫기; 그렇지 않으면 `performSend(session:)` (전송 chime을 한 번 재생하고, 전달하고, 닫습니다).
   - push-to-talk: 지연 없음; wake-word: 자동 전송을 위한 선택적 지연.
   - push-to-talk이 완료된 후 wake 런타임에 단기 쿨다운을 적용하여 wake-word가 즉시 다시 발생하지 않도록 합니다.
5. **로그 기록**
   - 코디네이터는 `bot.molt` 서브시스템에서 `.info` 로그를 발신합니다, 범주는 `voicewake.overlay` 및 `voicewake.chime`입니다.
   - 주요 이벤트: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## 디버깅 체크리스트

- 문제가 있는 오버레이를 재현하는 동안 로그 스트림을 확인하세요:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 활성 세션 토큰이 하나만 존재하는지 확인하세요; 오래된 콜백은 코디네이터에 의해 드롭되어야 합니다.
- push-to-talk 릴리스가 항상 활성 토큰과 함께 `endCapture`를 호출하도록 보장하세요; 텍스트가 비어 있는 경우 chime이나 전송없이 `dismiss`를 예상합니다.

## 마이그레이션 단계 (제안)

1. `VoiceSessionCoordinator`, `VoiceSession`, 및 `VoiceSessionPublisher`를 추가합니다.
2. `VoiceWakeRuntime`을 리팩터링하여 `VoiceWakeOverlayController`를 직접 건드리지 않고 세션을 생성/업데이트/종료합니다.
3. `VoicePushToTalk`을 리팩터링하여 기존 세션을 채택하고 릴리스 시 `endCapture`를 호출합니다; 런타임 쿨다운을 적용합니다.
4. `VoiceWakeOverlayController`를 게시자에 연결합니다; 런타임/PTT에서 직접 호출을 제거합니다.
5. 세션 채택, 쿨다운, 빈 텍스트 닫기를 위한 통합 테스트를 추가합니다.