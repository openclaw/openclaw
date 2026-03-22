---
title: "도구 루프 감지"
summary: "반복적인 도구 호출 루프를 감지하는 가드레일을 활성화하고 조정하는 방법"
read_when:
  - 사용자가 에이전트가 도구 호출을 반복하며 멈추는 것을 보고할 때
  - 반복 호출 보호를 조정해야 할 때
  - 에이전트 도구/런타임 정책을 편집할 때
x-i18n:
  source_path: docs/tools/loop-detection.md
---

# 도구 루프 감지

OpenClaw 은 에이전트가 반복적인 도구 호출 패턴에 갇히는 것을 방지할 수 있습니다.
이 가드는 **기본적으로 비활성화**되어 있습니다.

엄격한 설정에서 합법적인 반복 호출을 차단할 수 있으므로 필요한 경우에만 활성화하세요.

## 존재 이유

- 진행되지 않는 반복적인 시퀀스를 감지합니다.
- 고빈도 무결과 루프 (동일한 도구, 동일한 입력, 반복 오류) 를 감지합니다.
- 알려진 폴링 도구의 특정 반복 호출 패턴을 감지합니다.

## 구성 블록

전역 기본값:

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

에이전트별 재정의 (선택사항):

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### 필드 동작

- `enabled`: 마스터 스위치. `false`이면 루프 감지가 수행되지 않습니다.
- `historySize`: 분석을 위해 유지하는 최근 도구 호출 수.
- `warningThreshold`: 패턴을 경고로만 분류하기 전의 임계값.
- `criticalThreshold`: 반복 루프 패턴을 차단하는 임계값.
- `globalCircuitBreakerThreshold`: 전역 무진행 브레이커 임계값.
- `detectors.genericRepeat`: 동일한 도구 + 동일한 파라미터 반복 패턴을 감지합니다.
- `detectors.knownPollNoProgress`: 상태 변경 없는 알려진 폴링 유사 패턴을 감지합니다.
- `detectors.pingPong`: 교차 핑퐁 패턴을 감지합니다.

## 권장 설정

- `enabled: true`로 시작하고 기본값은 변경하지 마세요.
- 임계값 순서를 `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`로 유지하세요.
- 오탐이 발생하는 경우:
  - `warningThreshold` 및/또는 `criticalThreshold`를 높이세요
  - (선택사항) `globalCircuitBreakerThreshold`를 높이세요
  - 문제를 일으키는 감지기만 비활성화하세요
  - 덜 엄격한 히스토리 컨텍스트를 위해 `historySize`를 줄이세요

## 로그 및 예상 동작

루프가 감지되면 OpenClaw 은 루프 이벤트를 보고하고 심각도에 따라 다음 도구 사이클을 차단하거나 완화합니다.
이를 통해 사용자를 폭주하는 토큰 비용과 잠금으로부터 보호하면서 정상적인 도구 접근을 유지합니다.

- 먼저 경고와 일시적 억제를 선호합니다.
- 반복적인 증거가 축적될 때만 에스컬레이션합니다.

## 참고 사항

- `tools.loopDetection`은 에이전트 수준 재정의와 병합됩니다.
- 에이전트별 설정은 전역 값을 완전히 재정의하거나 확장합니다.
- 설정이 없으면 가드레일은 꺼진 상태로 유지됩니다.
