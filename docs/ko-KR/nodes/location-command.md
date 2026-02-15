---
summary: "Location command for nodes (location.get), permission modes, and background behavior"
read_when:
  - Adding location node support or permissions UI
  - Designing background location + push flows
title: "Location Command"
x-i18n:
  source_hash: 23124096256384d2b28157352b072309c61c970a20e009aac5ce4a8250dc3764
---

# 위치 명령(노드)

## 요약;DR

- `location.get`는 노드 명령입니다(`node.invoke`를 통해).
- 기본적으로 꺼져 있습니다.
- 설정 사용 선택기: 끄기 / 사용 중 / 항상.
- 별도의 토글: 정확한 위치.

## 선택기가 필요한 이유(단순한 스위치가 아님)

OS 권한은 다단계입니다. 인앱 선택기를 노출할 수 있지만 OS는 여전히 실제 승인을 결정합니다.

- iOS/macOS: 사용자는 시스템 프롬프트/설정에서 **사용하는 동안** 또는 **항상**을 선택할 수 있습니다. 앱은 업그레이드를 요청할 수 있지만 OS에는 설정이 필요할 수 있습니다.
- 안드로이드: 백그라운드 위치는 별도의 권한입니다. Android 10 이상에서는 설정 흐름이 필요한 경우가 많습니다.
- 정확한 위치는 별도의 권한입니다(iOS 14+ "정확함", Android "고급" 대 "대략").

UI의 선택기가 요청한 모드를 구동합니다. 실제 부여는 OS 설정에 있습니다.

## 설정 모델

노드당 장치:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: 부울

UI 동작:

- `whileUsing`를 선택하면 포그라운드 권한을 요청합니다.
- `always`를 선택하면 먼저 `whileUsing`를 확인한 다음 백그라운드를 요청합니다(또는 필요한 경우 사용자를 설정으로 보냅니다).
- OS가 요청한 레벨을 거부하는 경우 부여된 가장 높은 레벨로 돌아가서 상태를 표시합니다.

## 권한 매핑(node.permissions)

선택사항. macOS 노드는 권한 맵을 통해 `location`를 보고합니다. iOS/Android는 생략될 수 있습니다.

## 명령: `location.get`

`node.invoke`를 통해 호출됩니다.

매개변수(권장):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

응답 페이로드:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

오류(안정적인 코드):

- `LOCATION_DISABLED`: 선택기가 꺼져 있습니다.
- `LOCATION_PERMISSION_REQUIRED`: 요청한 모드에 대한 권한이 누락되었습니다.
- `LOCATION_BACKGROUND_UNAVAILABLE`: 앱이 백그라운드로 설정되어 있지만 사용 중에만 허용됩니다.
- `LOCATION_TIMEOUT`: 시간 내에 수정되지 않습니다.
- `LOCATION_UNAVAILABLE`: 시스템 오류 / 공급자 없음.

## 백그라운드 동작(향후)

목표: 모델은 노드가 백그라운드인 경우에도 위치를 요청할 수 있지만 다음과 같은 경우에만 가능합니다.

- 사용자가 **항상**을 선택했습니다.
- OS는 백그라운드 위치를 부여합니다.
- 위치 확인을 위해 앱이 백그라운드에서 실행되도록 허용합니다(iOS 백그라운드 모드/안드로이드 포그라운드 서비스 또는 특별 허용).

푸시 트리거 흐름(향후):

1. 게이트웨이는 노드에 푸시(자동 푸시 또는 FCM 데이터)를 보냅니다.
2. 노드가 잠시 깨어나고 장치에서 위치를 요청합니다.
3. 노드는 페이로드를 게이트웨이로 전달합니다.

참고:

- iOS: 항상 권한 + 백그라운드 위치 모드가 필요합니다. 자동 푸시가 제한될 수 있습니다. 간헐적인 실패가 예상됩니다.
- Android: 백그라운드 위치를 확인하려면 포그라운드 서비스가 필요할 수 있습니다. 그렇지 않으면 거부를 예상하십시오.

## 모델/도구 통합

- 도구 표면: `nodes` 도구는 `location_get` 작업을 추가합니다(노드 필요).
- CLI: `openclaw nodes location get --node <id>`.
- 상담사 지침: 사용자가 위치를 활성화하고 범위를 이해하는 경우에만 전화하세요.

## UX 카피(권장)

- 끄기: “위치 공유가 비활성화되었습니다.”
- 사용 중 : “OpenClaw가 열려 있는 경우에만 해당됩니다.”
- 항상: "백그라운드 위치를 허용합니다. 시스템 권한이 필요합니다."
- 정확함: "정확한 GPS 위치를 사용합니다. 대략적인 위치를 공유하려면 끄세요."
