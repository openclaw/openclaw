---
read_when:
    - 메뉴 표시줄 아이콘 동작 변경
summary: macOS의 OpenClaw에 대한 메뉴 표시줄 아이콘 상태 및 애니메이션
title: 메뉴바 아이콘
x-i18n:
    generated_at: "2026-02-08T16:04:36Z"
    model: gtx
    provider: google-translate
    source_hash: a67a6e6bbdc2b611ba365d3be3dd83f9e24025d02366bc35ffcce9f0b121872b
    source_path: platforms/mac/icon.md
    workflow: 15
---

# 메뉴 표시줄 아이콘 상태

작성자: steipete · 업데이트 날짜: 2025-12-06 · 범위: macOS 앱(`apps/macos`)

- **게으른:** 일반 아이콘 애니메이션(깜박임, 가끔 흔들림).
- **일시중지됨:** 상태 아이템 사용 `appearsDisabled`; 움직임이 없습니다.
- **음성 트리거(큰 귀):** 음성 깨우기 감지기 호출 `AppState.triggerVoiceEars(ttl: nil)` 깨우라는 말이 들리면 유지 `earBoostActive=true` 발언이 캡처되는 동안. 귀가 확장되고(1.9x) 가독성을 위해 원형 귀 구멍이 생긴 후 드롭됩니다. `stopVoiceEars()` 1초간 침묵 후. 인앱 음성 파이프라인에서만 실행됩니다.
- **작업 중(에이전트 실행 중):** `AppState.isWorking=true` "꼬리/다리 빠르게 움직이는" 미세 동작을 구동합니다. 작업이 진행되는 동안 다리 흔들기가 더 빨라지고 약간의 오프셋이 발생합니다. 현재 WebChat 에이전트 실행을 전환하고 있습니다. 다른 긴 작업을 연결할 때 동일한 토글을 추가하십시오.

배선 포인트

- 음성 깨우기: 런타임/테스터 호출 `AppState.triggerVoiceEars(ttl: nil)` 트리거 및 `stopVoiceEars()` 캡처 창과 일치하도록 1초간 침묵 후.
- 상담원 활동: 설정 `AppStateStore.shared.setWorking(true/false)` 작업 범위 주변(WebChat 에이전트 호출에서 이미 수행됨) 기간을 짧게 유지하고 재설정하세요. `defer` 애니메이션이 멈추는 것을 방지하기 위한 블록입니다.

모양 및 크기

- 기본 아이콘이 그려져 있습니다. `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- 귀 스케일의 기본값은 다음과 같습니다. `1.0`; 음성 부스트 세트 `earScale=1.9` 그리고 토글 `earHoles=true` 전체 프레임을 변경하지 않고(36×36px Retina 백업 저장소로 렌더링된 18×18pt 템플릿 이미지)
- Scurry는 작은 수평 흔들림과 함께 최대 1.0까지 다리 흔들기를 사용합니다. 기존의 유휴 흔들림에 추가됩니다.

행동 메모

- 귀/작업을 위한 외부 CLI/브로커 토글이 없습니다. 실수로 펄럭이는 것을 방지하려면 앱 자체 신호 내부에 보관하세요.
- TTL을 짧게(10초 미만) 유지하면 작업이 중단될 경우 아이콘이 빠르게 기준선으로 돌아갈 수 있습니다.
