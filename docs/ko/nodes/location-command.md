---
summary: "노드용 위치 명령(location.get), 권한 모드, 및 백그라운드 동작"
read_when:
  - 위치 노드 지원 또는 권한 UI 추가 시
  - 백그라운드 위치 + 푸시 흐름 설계 시
title: "위치 명령"
---

# 위치 명령(노드)

## TL;DR

- `location.get` 는 노드 명령입니다(`node.invoke` 를 통해).
- 기본값은 꺼짐입니다.
- 설정은 선택기를 사용합니다: 꺼짐 / 사용 중일 때 / 항상.
- 별도의 토글: 정확한 위치.

## 왜 스위치가 아닌 선택기인가

OS 권한은 다단계입니다. 앱 내에서는 선택기를 노출할 수 있지만, 실제 부여 여부는 OS 가 결정합니다.

- iOS/macOS: 사용자는 시스템 프롬프트/설정에서 **사용 중일 때** 또는 **항상** 을 선택할 수 있습니다. 앱은 업그레이드를 요청할 수 있지만, OS 가 설정 이동을 요구할 수 있습니다.
- Android: 백그라운드 위치는 별도의 권한이며, Android 10+ 에서는 종종 설정 흐름이 필요합니다.
- 정확한 위치는 별도의 권한입니다(iOS 14+ 의 '정확한 위치', Android 의 '정밀(fine)' 대 '대략(coarse)').

UI 의 선택기는 우리가 요청하는 모드를 결정하며, 실제 부여 상태는 OS 설정에 존재합니다.

## 설정 모델

노드 디바이스별:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI 동작:

- `whileUsing` 을 선택하면 포그라운드 권한을 요청합니다.
- `always` 을 선택하면 먼저 `whileUsing` 을 보장한 다음, 백그라운드 권한을 요청합니다(필요 시 사용자를 설정으로 보냄).
- OS 가 요청된 수준을 거부하면, 부여된 최고 수준으로 되돌리고 상태를 표시합니다.

## 권한 매핑(node.permissions)

선택 사항입니다. macOS 노드는 권한 맵을 통해 `location` 을 보고합니다. iOS/Android 는 이를 생략할 수 있습니다.

## 명령: `location.get`

`node.invoke` 를 통해 호출됩니다.

12. 매개변수(권장):

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

오류(안정 코드):

- `LOCATION_DISABLED`: 선택기가 꺼져 있습니다.
- `LOCATION_PERMISSION_REQUIRED`: 요청된 모드에 필요한 권한이 없습니다.
- `LOCATION_BACKGROUND_UNAVAILABLE`: 앱이 백그라운드 상태이나 '사용 중일 때' 만 허용됩니다.
- `LOCATION_TIMEOUT`: 제한 시간 내에 위치를 획득하지 못했습니다.
- `LOCATION_UNAVAILABLE`: 시스템 실패 / 제공자 없음.

## 백그라운드 동작(향후)

목표: 노드가 백그라운드 상태여도 모델이 위치를 요청할 수 있도록 하되, 다음 조건을 모두 만족해야 합니다.

- 사용자가 **항상** 을 선택함.
- OS 가 백그라운드 위치를 허용함.
- 앱이 위치를 위한 백그라운드 실행이 허용됨(iOS 백그라운드 모드 / Android 포그라운드 서비스 또는 특별 허용).

푸시 트리거 흐름(향후):

1. Gateway(게이트웨이) 가 노드에 푸시를 전송합니다(사일런트 푸시 또는 FCM 데이터).
2. 노드가 잠시 깨어나 디바이스에서 위치를 요청합니다.
3. 노드가 페이로드를 Gateway(게이트웨이) 로 전달합니다.

참고:

- iOS: 항상 권한 + 백그라운드 위치 모드가 필요합니다. 사일런트 푸시는 제한될 수 있으며, 간헐적인 실패를 예상해야 합니다.
- Android: 백그라운드 위치에는 포그라운드 서비스가 필요할 수 있으며, 그렇지 않으면 거부를 예상해야 합니다.

## 모델/도구 통합

- 도구 표면: `nodes` 도구가 `location_get` 액션을 추가합니다(노드 필요).
- CLI: `openclaw nodes location get --node <id>`.
- 에이전트 가이드라인: 사용자가 위치를 활성화했고 범위를 이해하는 경우에만 호출합니다.

## UX 문구(권장)

- 꺼짐: “위치 공유가 비활성화되어 있습니다.”
- 사용 중일 때: “OpenClaw 가 열려 있을 때만.”
- 항상: “백그라운드 위치를 허용합니다. 시스템 권한이 필요합니다.”
- 정확한 위치: “정확한 GPS 위치를 사용합니다. 토글을 끄면 대략적인 위치를 공유합니다.”
