---
summary: "macOS 에서 OpenClaw 메뉴 바 아이콘 상태 및 애니메이션"
read_when:
  - 메뉴 바 아이콘 동작을 변경할 때
title: "메뉴 바 아이콘"
x-i18n:
  source_path: docs/platforms/mac/icon.md
---

# 메뉴 바 아이콘 상태

작성자: steipete · 업데이트: 2025-12-06 · 범위: macOS 앱 (`apps/macos`)

- **유휴:** 일반 아이콘 애니메이션 (깜빡임, 간헐적 흔들림).
- **일시 정지:** 상태 항목이 `appearsDisabled` 를 사용; 움직임 없음.
- **음성 트리거 (큰 귀):** 음성 웨이크 감지기가 웨이크 워드를 들으면 `AppState.triggerVoiceEars(ttl: nil)` 을 호출하여, 발화가 캡처되는 동안 `earBoostActive=true` 를 유지합니다. 귀가 확대되고 (1.9 배), 가독성을 위한 원형 귀 구멍이 생기고, 1 초 침묵 후 `stopVoiceEars()` 를 통해 축소됩니다. 인앱 음성 파이프라인에서만 발동합니다.
- **작업 중 (에이전트 실행):** `AppState.isWorking=true` 가 "꼬리/다리 스커리" 마이크로 모션을 구동합니다: 더 빠른 다리 흔들림과 작업 진행 중 약간의 오프셋. 현재 WebChat 에이전트 실행에서 토글됩니다; 다른 긴 작업을 연결할 때 동일한 토글을 추가하세요.

연결 지점

- 음성 웨이크: 런타임/테스터가 트리거 시 `AppState.triggerVoiceEars(ttl: nil)` 을 호출하고 캡처 윈도우와 일치하도록 1 초 침묵 후 `stopVoiceEars()` 를 호출합니다.
- 에이전트 활동: 작업 범위에서 `AppStateStore.shared.setWorking(true/false)` 를 설정합니다 (WebChat 에이전트 호출에서 이미 완료). 범위를 짧게 유지하고 `defer` 블록에서 리셋하여 고정된 애니메이션을 방지합니다.

형태 및 크기

- 기본 아이콘은 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` 에서 그려집니다.
- 귀 스케일은 기본값 `1.0`; 음성 부스트는 전체 프레임을 변경하지 않고 `earScale=1.9` 와 `earHoles=true` 를 토글합니다 (36x36 px Retina 백킹 스토어로 렌더링된 18x18 pt 템플릿 이미지).
- 스커리는 약 ~1.0 까지의 다리 흔들림과 작은 수평 진동을 사용합니다; 기존 유휴 흔들림에 추가됩니다.

동작 참고

- 귀/작업 중에 대한 외부 CLI/브로커 토글이 없습니다; 우발적인 플래핑을 방지하기 위해 앱 자체 신호에 내부적으로 유지합니다.
- TTL 을 짧게 유지하세요 (10 초 미만) 작업이 멈추면 아이콘이 빠르게 기본 상태로 돌아가도록.
