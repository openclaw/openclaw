---
summary: "노드의 위치 명령어 (location.get), 권한 모드 및 백그라운드 동작"
read_when:
  - 위치 노드 지원 또는 권한 UI 추가 시
  - 백그라운드 위치 + 푸시 흐름 설계 시
title: "위치 명령어"
---

# 위치 명령어 (노드)

## 요약

- `location.get`은 노드 명령어입니다 (`node.invoke`를 통해).
- 기본적으로 꺼짐.
- 설정은 선택기를 사용: Off / While Using / Always.
- 별도의 토글: 정확한 위치.

## 선택기인 이유 (단순 스위치가 아님)

OS 권한은 다단계입니다. 우리는 앱 내에서 선택기를 노출할 수 있지만, 실제 승인 여부는 OS에서 결정합니다.

- iOS/macOS: 사용자는 시스템 프롬프트/설정에서 **While Using** 또는 **Always**를 선택할 수 있습니다. 앱은 업그레이드를 요청할 수 있지만, OS는 설정 화면을 요구할 수 있습니다.
- Android: 백그라운드 위치는 별도의 권한이며, Android 10+에서는 설정 화면을 요구하는 경우가 많습니다.
- 정확한 위치는 별도의 승인입니다 (iOS 14+ “Precise”, Android “세밀한” vs “대략적인”).

UI의 선택기는 요청된 모드를 주도하며, 실제 승인은 OS 설정에 저장됩니다.

## 설정 모델

노드 디바이스별:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI 동작:

- `whileUsing`을 선택하면 전경 권한을 요청합니다.
- `always`를 선택하면 먼저 `whileUsing`을 보장한 후 백그라운드를 요청합니다 (필요 시 사용자를 설정으로 보냄).
- OS가 요청된 수준을 거부할 경우, 가장 높은 승인 수준으로 되돌리고 상태를 표시합니다.

## 권한 매핑 (node.permissions)

선택적입니다. macOS 노드는 permission 맵을 통해 `location`을 보고합니다; iOS/Android는 이를 생략할 수 있습니다.

## 명령어: `location.get`

`node.invoke`를 통해 호출됩니다.

제안된 매개변수:

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

오류 (안정적인 코드):

- `LOCATION_DISABLED`: 선택기가 꺼져 있음.
- `LOCATION_PERMISSION_REQUIRED`: 요청된 모드에 대한 권한이 없음.
- `LOCATION_BACKGROUND_UNAVAILABLE`: 앱이 백그라운드 상태이며 While Using만 허용됨.
- `LOCATION_TIMEOUT`: 시간 초과로 위치를 잡지 못함.
- `LOCATION_UNAVAILABLE`: 시스템 오류 / 프로바이더 없음.

## 백그라운드 동작 (미래 계획)

목표: 모델이 노드가 백그라운드 상태에서도 위치를 요청할 수 있도록 함. 단, 다음의 경우에만:

- 사용자가 **Always**를 선택함.
- OS가 백그라운드 위치를 허용함.
- 앱이 백그라운드에서 위치를 위해 실행될 수 있음 (iOS 백그라운드 모드 / Android 포그라운드 서비스 또는 특별 허용).

푸시 트리거 흐름 (미래 계획):

1. 게이트웨이가 노드에 푸시를 보냅니다 (무음 푸시 또는 FCM 데이터).
2. 노드가 잠시 깨어나 장치에서 위치를 요청합니다.
3. 노드가 페이로드를 게이트웨이에 전달합니다.

주의사항:

- iOS: 항상 권한 + 백그라운드 위치 모드 필요. 무음 푸시는 제한될 수 있으므로 간헐적인 실패를 예상해야 합니다.
- Android: 백그라운드 위치는 포그라운드 서비스를 요구할 수 있으며, 그렇지 않으면 거부될 수 있습니다.

## 모델/도구 통합

- 도구 표시: `nodes` 도구가 `location_get` 액션을 추가함 (노드 필요).
- CLI: `openclaw nodes location get --node <id>`.
- 에이전트 가이드라인: 사용자가 위치를 활성화하고 범위를 이해할 때만 호출.

## UX 문구 (제안)

- 꺼짐: “위치 공유가 비활성화되었습니다.”
- 사용 중: “OpenClaw가 열려 있을 때만.”
- 항상: “백그라운드 위치 허용. 시스템 권한 필요.”
- 정확: “정확한 GPS 위치 사용. 토글을 끄면 대략적인 위치를 공유합니다.”
