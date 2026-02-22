---
title: "도구 루프 탐지"
description: "반복되거나 정체된 도구 호출 루프를 방지하기 위한 선택적 안전장치를 구성합니다."
read_when:
  - 사용자가 에이전트가 도구 호출을 반복하는 문제를 보고합니다.
  - 반복 호출 보호 기능을 조정해야 합니다.
  - 에이전트 도구/런타임 정책을 편집하고 있습니다.
---

# 도구 루프 탐지

OpenClaw는 에이전트가 반복적인 도구 호출 패턴에 갇히지 않도록 할 수 있습니다.
안전장치는 **기본적으로 비활성화**되어 있습니다.

합법적인 반복 호출을 엄격한 설정으로 차단할 수 있으므로 필요할 때만 활성화하십시오.

## 존재 이유

- 진행이 없는 반복 시퀀스를 탐지합니다.
- 동일한 도구, 동일한 입력, 반복적 오류로 인한 고빈도의 무결과 루프를 탐지합니다.
- 알려진 폴링 도구에 대한 특정 반복 호출 패턴을 탐지합니다.

## 구성 블록

전역 기본값:

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 20,
      detectorCooldownMs: 12000,
      repeatThreshold: 3,
      criticalThreshold: 6,
      detectors: {
        repeatedFailure: true,
        knownPollLoop: true,
        repeatingNoProgress: true,
      },
    },
  },
}
```

에이전트별 오버라이드 (선택 사항):

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            repeatThreshold: 2,
            criticalThreshold: 5,
          },
        },
      },
    ],
  },
}
```

### 필드 동작

- `enabled`: 마스터 스위치. `false`이면 루프 탐지를 수행하지 않습니다.
- `historySize`: 분석을 위한 최근 도구 호출의 개수.
- `detectorCooldownMs`: 무진행 탐지에 사용되는 시간 창.
- `repeatThreshold`: 경고/차단이 시작되기 전의 최소 반복 횟수.
- `criticalThreshold`: 더 강력한 임계값으로, 엄격한 처리를 촉발할 수 있습니다.
- `detectors.repeatedFailure`: 동일한 호출 경로에서 반복된 실패 시도를 탐지합니다.
- `detectors.knownPollLoop`: 알려진 폴링과 같은 루프를 탐지합니다.
- `detectors.repeatingNoProgress`: 상태 변화 없이 고빈도 반복 호출을 탐지합니다.

## 권장 설정

- `enabled: true`로 시작하고, 기본값을 변경하지 않습니다.
- 오탐지 발생 시:
  - `repeatThreshold` 및/또는 `criticalThreshold`를 높입니다.
  - 문제를 일으키는 탐지만 비활성화합니다.
  - 덜 엄격한 역사적 맥락을 위해 `historySize`를 줄입니다.

## 로그 및 예상 동작

루프가 탐지되면, OpenClaw는 루프 이벤트를 보고하고 심각도에 따라 다음 도구 사이클을 차단하거나 줄입니다.
이는 사용자에게 과도한 토큰 사용과 정체를 방지하면서 정상적인 도구 접근을 유지할 수 있게 합니다.

- 경고와 임시 억제를 우선으로 합니다.
- 반복적인 증거가 쌓일 때만 조치를 강화합니다.

## 비고

- `tools.loopDetection`은 에이전트 수준 오버라이드와 병합됩니다.
- 에이전트별 구성은 전역 값을 완전히 덮어쓰거나 확장합니다.
- 구성 자체가 없으면 안전장치는 비활성화 상태를 유지합니다.
