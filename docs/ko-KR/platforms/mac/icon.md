---
summary: "macOS에서 OpenClaw의 메뉴 막대 아이콘 상태와 애니메이션"
read_when:
  - 메뉴 막대 아이콘 동작 변경
title: "메뉴 막대 아이콘"
---

# 메뉴 막대 아이콘 상태

작성자: steipete · 업데이트: 2025-12-06 · 범위: macOS 앱 (`apps/macos`)

- **대기:** 기본 아이콘 애니메이션 (깜박임, 가끔 비틀림).
- **일시 중지:** 상태 항목이 `appearsDisabled`를 사용; 움직임 없음.
- **음성 트리거 (큰 귀):** 음성 웨이크 감지기가 깨우는 말을 들으면 `AppState.triggerVoiceEars(ttl: nil)`를 호출하여 발언이 캡처되는 동안 `earBoostActive=true`를 유지합니다. 귀가 확대 (1.9배)되어 가독성을 위한 원형 귀홀이 생기며, 1초의 침묵 후 `stopVoiceEars()`를 통해 사라집니다. 이 기능은 앱 내 음성 파이프라인에서만 실행됩니다.
- **작업 중 (에이전트 실행 중):** `AppState.isWorking=true`가 "꼬리/다리 움직임" 미세 모션을 구동합니다: 작업이 진행되는 동안 빠른 다리 비틀림과 약간의 오프셋. 현재 WebChat 에이전트 실행 시에 전환되며, 다른 긴 작업에 대해서도 동일한 전환을 추가하십시오.

연결 지점

- 음성 웨이크: 실행 중일 때 트리거에서 `AppState.triggerVoiceEars(ttl: nil)`를 호출하고 침묵이 1초 이상 유지되면 `stopVoiceEars()`를 호출하여 캡처 창에 맞추십시오.
- 에이전트 활동: 작업 기간 주위에 `AppStateStore.shared.setWorking(true/false)`를 설정합니다 (이미 WebChat 에이전트 호출에서 완료됨). 작업 기간을 짧게 유지하고 `defer` 블록에서 재설정하여 애니메이션이 멈추지 않도록 합니다.

모양 및 크기

- 기본 아이콘은 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`에서 그려집니다.
- 귀 크기 기본값은 `1.0`이며, 음성 부스트는 `earScale=1.9`로 설정하고 `earHoles=true`를 전환하여 전체 프레임을 변경하지 않습니다 (18×18 pt 템플릿 이미지를 36×36 px Retina 백킹 스토어에 렌더링).
- 빠른 움직임에는 다리 비틀림이 약 ~1.0까지 사용되며, 기존 대기 비틀림에 추가됩니다.

동작 주의사항

- 외부 CLI/브로커에 대한 귀/작업 여부의 전환은 없습니다. 앱 자체 신호에 내부적으로 유지하여 우발적인 플랩을 방지하십시오.
- TTLs을 짧게 유지 (&lt;10초) 하여 작업이 중단되면 아이콘이 기본 상태로 빨리 돌아가도록 합니다.
