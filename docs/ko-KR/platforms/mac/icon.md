---
summary: "macOS의 OpenClaw를 위한 메뉴 바 아이콘 상태 및 애니메이션"
read_when:
  - 메뉴 바 아이콘 동작을 변경할 때
title: "메뉴 바 아이콘"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/icon.md"
  workflow: 15
---

# 메뉴 바 아이콘 상태

작성자: steipete · 업데이트됨: 2025-12-06 · 범위: macOS 앱 (`apps/macos`)

- **유휴**: 정상 아이콘 애니메이션 (깜박임, 가끔 흔들림).
- **일시 중지됨**: 상태 항목이 `appearsDisabled`를 사용합니다. 모션 없음.
- **음성 트리거 (큰 귀)**: 음성 웨이크 탐지기가 웨이크 단어를 들을 때 `AppState.triggerVoiceEars(ttl: nil)`을 호출하며, 발화가 캡처되는 동안 `earBoostActive=true`를 유지합니다. 귀가 확대됩니다 (1.9배), 가독성을 위해 원형 귀 구멍을 얻으며, `stopVoiceEars()` 이후 1초의 무음을 통해 떨어집니다. 인앱 음성 파이프라인에서만 발사됩니다.
- **작업 중 (에이전트 실행)**: `AppState.isWorking=true`는 "꼬리/다리 스커리" 마이크로 모션을 주도합니다: 더 빠른 다리 흔들림 및 작업이 진행 중일 때 약간의 오프셋. 현재 WebChat 에이전트 실행 주위에서 전환됩니다. 다른 긴 작업 주위에 동일한 전환을 추가하십시오.

와이어링 포인트

- 음성 웨이크: 런타임/테스터는 트리거 시 `AppState.triggerVoiceEars(ttl: nil)`을 호출하고 캡처 윈도우와 일치하도록 1초 무음 후 `stopVoiceEars()`를 호출합니다.
- 에이전트 활동: 작업 스팬 주위에 `AppStateStore.shared.setWorking(true/false)`을 설정합니다 (WebChat 에이전트 호출에서 이미 수행됨). 스팬을 짧게 유지하고 고착된 애니메이션을 방지하기 위해 `defer` 블록에서 재설정합니다.

모양 & 크기

- 기본 아이콘은 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`에서 그려집니다.
- 귀 스케일은 기본값 `1.0`입니다. 음성 부스트는 `earScale=1.9`를 설정하고 전체 프레임을 변경하지 않고 `earHoles=true`를 전환합니다 (18×18 pt 템플릿 이미지는 36×36 px Retina 백킹 스토어로 렌더링됨).
- 스커리는 다리 흔들림을 ~1.0까지 사용하며 작은 수평 지터를 포함합니다. 기존 유휴 흔들림에 추가됩니다.

동작 참고 사항

- 귀/작업에 대한 외부 CLI/브로커 전환 없음. 앱의 자체 신호에 내부적으로 유지하여 우발적인 펄럭임을 방지합니다.
- TTL을 짧게 유지합니다 (<10초). 작업이 행을 때 아이콘이 기본선으로 빠르게 돌아옵니다.
