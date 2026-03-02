---
summary: "노드용 위치 커맨드(location.get), 권한 모드 및 백그라운드 동작"
read_when:
  - 위치 노드 지원 또는 권한 UI를 추가할 때
  - 백그라운드 위치 + 푸시 흐름을 설계할 때
title: "위치 커맨드"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/location-command.md
workflow: 15
---

# 위치 커맨드(노드)

## TL;DR

- `location.get`은 노드 커맨드(`node.invoke`를 통해).
- 기본값으로 꺼짐.
- 설정은 선택기를 사용: Off / While Using / Always.
- 별도 전환: Precise Location.

## 왜 선택기인가(스위치가 아님)

OS 권한은 다단계입니다. 앱 내에서 선택기를 노출할 수 있지만 OS는 실제 부여를 결정합니다.

- iOS/macOS: 사용자는 시스템 프롬프트/Settings에서 **While Using** 또는 **Always**를 선택할 수 있습니다. 앱은 업그레이드를 요청할 수 있지만 OS는 Settings을 요구할 수 있습니다.
- Android: 백그라운드 위치는 별도 권한; Android 10+에서 종종 Settings 흐름을 요구합니다.
- Precise location은 별도 부여입니다(iOS 14+ "Precise", Android "fine" vs "coarse").

UI의 선택기는 요청 모드를 구동; 실제 부여는 OS 설정에 있습니다.

## 설정 모델

노드 장치별:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI 동작:

- `whileUsing` 선택은 포그라운드 권한을 요청합니다.
- `always` 선택은 먼저 `whileUsing`를 보장한 다음 백그라운드를 요청합니다(또는 필요한 경우 사용자를 Settings로 보냅니다).
- OS가 요청된 레벨을 거부하면 가장 높은 부여된 레벨로 되돌아가고 상태를 표시합니다.

## 커맨드: `location.get`

`node.invoke`를 통해 호출됩니다.

파라미터(권장):

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

오류(안정적 코드):

- `LOCATION_DISABLED`: 선택기가 꺼져 있습니다.
- `LOCATION_PERMISSION_REQUIRED`: 요청된 모드에 대한 권한이 누락되었습니다.
- `LOCATION_BACKGROUND_UNAVAILABLE`: 앱이 백그라운드이지만 While Using만 허용됩니다.
- `LOCATION_TIMEOUT`: 시간 내 수정 없음.
- `LOCATION_UNAVAILABLE`: 시스템 실패 / 제공자 없음.

## 백그라운드 동작(미래)

목표: 모델이 노드가 백그라운드되어 있을 때도 위치를 요청할 수 있지만 다음의 경우만:

- 사용자가 **Always** 선택.
- OS가 백그라운드 위치 부여.
- 앱이 위치에 대해 백그라운드에서 실행되도록 허용됨(iOS 백그라운드 모드 / Android 포그라운드 서비스 또는 특별 허용).

푸시 트리거 흐름(미래):

1. Gateway는 노드로 푸시를 전송합니다(조용한 푸시 또는 FCM 데이터).
2. 노드가 잠시 깨어나 장치에서 위치를 요청합니다.
3. 노드는 페이로드를 Gateway로 전달합니다.

참고:

- iOS: Always 권한 + 백그라운드 위치 모드 필요. 조용한 푸시는 스로틀될 수 있습니다; 간헐적 실패를 예상하세요.
- Android: 백그라운드 위치는 포그라운드 서비스를 요구할 수 있습니다; 그렇지 않으면 거부를 예상하세요.

## 모델/도구 통합

- 도구 표면: `nodes` 도구는 `location_get` 액션을 추가합니다(노드 필요).
- CLI: `openclaw nodes location get --node <id>`.
- 에이전트 가이드라인: 사용자가 위치를 활성화하고 범위를 이해할 때만 호출합니다.

## UX 복사(권장)

- Off: "Location sharing is disabled."
- While Using: "Only when OpenClaw is open."
- Always: "Allow background location. Requires system permission."
- Precise: "Use precise GPS location. Toggle off to share approximate location."
