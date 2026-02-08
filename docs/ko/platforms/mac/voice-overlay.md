---
read_when:
    - 음성 오버레이 동작 조정
summary: 깨우기 단어와 눌러서 말하기가 겹치는 경우 음성 오버레이 수명 주기
title: 음성 오버레이
x-i18n:
    generated_at: "2026-02-08T16:01:21Z"
    model: gtx
    provider: google-translate
    source_hash: 5d32704c412295c24ae8310975a056b1df370344b8c607ffae91b91403a71b7a
    source_path: platforms/mac/voice-overlay.md
    workflow: 15
---

# 음성 오버레이 수명 주기(macOS)

대상: macOS 앱 기여자. 목표: 깨우기 단어와 눌러서 말하기가 겹칠 때 음성 오버레이를 예측 가능하게 유지합니다.

## 현재 의도

- 오버레이가 wake-word에서 이미 표시되고 사용자가 단축키를 누르면 단축키 세션이 _채택하다_ 재설정하는 대신 기존 텍스트를 그대로 유지합니다. 단축키를 누르고 있는 동안 오버레이는 계속 유지됩니다. 사용자가 놓을 때: 잘린 텍스트가 있으면 보내고, 그렇지 않으면 닫습니다.
- 깨우기 단어만으로도 침묵 시 자동 전송됩니다. push-to-talk는 출시 즉시 전송됩니다.

## 시행(2025년 12월 9일)

- 오버레이 세션은 이제 캡처당(깨우기 단어 또는 푸시 투 토크) 토큰을 전달합니다. 토큰이 일치하지 않으면 부분/최종/전송/해제/레벨 업데이트가 삭제되어 오래된 콜백을 방지합니다.
- 눌러서 말하기는 눈에 보이는 오버레이 텍스트를 접두사로 채택합니다. 따라서 깨우기 오버레이가 작동하는 동안 단축키를 누르면 텍스트가 유지되고 새 음성이 추가됩니다. 현재 텍스트로 돌아가기 전에 최종 기록이 나올 때까지 최대 1.5초를 기다립니다.
- 차임벨/오버레이 로깅은 다음 시간에 내보내집니다. `info` 카테고리에서 `voicewake.overlay`, `voicewake.ptt`, 그리고 `voicewake.chime` (세션 시작, 부분, 최종, 전송, 해제, 차임 이유).

## 다음 단계

1. **VoiceSessionCoordinator(배우)**
   - 정확히 하나만 소유 `VoiceSession` 한 번에.
   - API(토큰 기반): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - 오래된 토큰을 전달하는 콜백을 삭제합니다(오래된 인식자가 오버레이를 다시 열지 못하도록 방지).
2. **VoiceSession(모델)**
   - 전지: `token`, `source` (wakeWord|pushToTalk), 커밋/휘발성 텍스트, 차임벨 플래그, 타이머(자동 전송, 유휴), `overlayMode` (표시|편집|전송), 휴지 기한.
3. **오버레이 바인딩**
   - `VoiceSessionPublisher` (`ObservableObject`)는 활성 세션을 SwiftUI에 미러링합니다.
   - `VoiceWakeOverlayView` 게시자를 통해서만 렌더링됩니다. 전역 싱글톤을 직접적으로 변경하지 않습니다.
   - 오버레이 사용자 작업(`sendNow`, `dismiss`, `edit`) 세션 토큰을 사용하여 코디네이터를 다시 호출합니다.
4. **통합 전송 경로**
   - ~에 `endCapture`: 잘린 텍스트가 비어 있으면 → 닫습니다. 또 다른 `performSend(session:)` (전송 차임을 한 번 재생하고 전달하고 해제합니다).
   - 푸쉬 투 토크(Push-to-talk): 지연 없음; wake-word: 자동 전송을 위한 선택적인 지연입니다.
   - 눌러서 말하기가 완료된 후 깨우기 런타임에 짧은 대기 시간을 적용하여 깨우기 단어가 즉시 다시 트리거되지 않도록 합니다.
5. **벌채 반출**
   - 코디네이터가 방출 `.info` 하위 시스템에 로그인 `bot.molt`, 카테고리 `voicewake.overlay` 그리고 `voicewake.chime`.
   - 주요 이벤트: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## 디버깅 체크리스트

- 고정 오버레이를 재생하면서 로그를 스트리밍합니다.

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- 하나의 활성 세션 토큰만 확인하세요. 오래된 콜백은 코디네이터가 삭제해야 합니다.
- PTT(Push-to-Talk) 릴리스가 항상 호출되는지 확인 `endCapture` 활성 토큰으로; 텍스트가 비어 있으면 예상하세요. `dismiss` 차임벨이나 전송 없이.

## 마이그레이션 단계(권장)

1. 추가하다 `VoiceSessionCoordinator`, `VoiceSession`, 그리고 `VoiceSessionPublisher`.
2. 리팩터링 `VoiceWakeRuntime` 터치하는 대신 세션 생성/업데이트/종료 `VoiceWakeOverlayController` 곧장.
3. 리팩터링 `VoicePushToTalk` 기존 세션을 채택하고 전화 `endCapture` 출시시; 런타임 쿨다운을 적용합니다.
4. 철사 `VoiceWakeOverlayController` 출판사에; 런타임/PTT에서 직접 호출을 제거합니다.
5. 세션 채택, 휴지 및 빈 텍스트 해제를 위한 통합 테스트를 추가합니다.
