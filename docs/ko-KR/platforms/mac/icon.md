---
summary: "Menu bar icon states and animations for OpenClaw on macOS"
read_when:
  - Changing menu bar icon behavior
title: "Menu Bar Icon"
x-i18n:
  source_hash: a67a6e6bbdc2b611ba365d3be3dd83f9e24025d02366bc35ffcce9f0b121872b
---

# 메뉴바 아이콘 상태

작성자: steipete · 업데이트 날짜: 2025-12-06 · 범위: macOS 앱 (`apps/macos`)

- **유휴:** 일반 아이콘 애니메이션(깜박임, 가끔 흔들림).
- **일시 중지됨:** 상태 항목은 `appearsDisabled`를 사용합니다. 움직임이 없습니다.
- **음성 트리거(큰 귀):** 음성 깨우기 감지기는 깨우기 단어가 들릴 때 `AppState.triggerVoiceEars(ttl: nil)`를 호출하고 발화가 캡처되는 동안 `earBoostActive=true`를 유지합니다. 귀는 1.9x로 확대되고, 가독성을 위해 원형 귀 구멍이 생기고, 1초 동안 침묵한 후 `stopVoiceEars()`를 통해 떨어집니다. 인앱 음성 파이프라인에서만 실행됩니다.
- **작업 중(에이전트 실행):** `AppState.isWorking=true`는 "꼬리/다리 움직임" 마이크로 모션을 구동합니다. 작업이 진행 중인 동안 다리 흔들기가 더 빨라지고 약간의 오프셋이 발생합니다. 현재 WebChat 에이전트 실행을 전환하고 있습니다. 다른 긴 작업을 연결할 때 동일한 토글을 추가하십시오.

배선 포인트

- 음성 깨우기: 런타임/테스터는 트리거 시 `AppState.triggerVoiceEars(ttl: nil)`를 호출하고 캡처 창과 일치하도록 1초 동안 침묵한 후 `stopVoiceEars()`를 호출합니다.
- 에이전트 활동: 작업 범위를 중심으로 `AppStateStore.shared.setWorking(true/false)`를 설정합니다(WebChat 에이전트 호출에서 이미 완료됨). 애니메이션이 멈추는 것을 방지하려면 범위를 짧게 유지하고 `defer` 블록에서 재설정하세요.

모양 및 크기

- `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`에 그려진 기본 아이콘입니다.
- 귀 스케일의 기본값은 `1.0`입니다. 음성 부스트는 전체 프레임을 변경하지 않고 `earScale=1.9`를 설정하고 `earHoles=true`를 토글합니다(36×36px Retina 백업 저장소로 렌더링된 18×18pt 템플릿 이미지).
- Scurry는 작은 수평 흔들림과 함께 최대 ~1.0까지 다리 흔들기를 사용합니다. 기존의 유휴 흔들림에 추가됩니다.

행동 메모

- 귀/작업을 위한 외부 CLI/브로커 토글이 없습니다. 실수로 펄럭이는 것을 방지하려면 앱 자체 신호 내부에 보관하세요.
- TTL을 짧게(&lt;10초) 유지하여 작업이 중단되면 아이콘이 빠르게 기준선으로 돌아갑니다.
