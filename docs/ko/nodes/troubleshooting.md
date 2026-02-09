---
summary: "노드 페어링, 포그라운드 요구 사항, 권한, 도구 실패 문제 해결"
read_when:
  - 노드는 연결되어 있지만 camera/canvas/screen/exec 도구가 실패하는 경우
  - 노드 페어링과 승인에 대한 정신 모델이 필요한 경우
title: "노드 문제 해결"
---

# 노드 문제 해결

상태에서 노드가 표시되지만 노드 도구가 실패할 때 이 페이지를 사용하십시오.

## 명령 사다리

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 노드별 검사를 실행합니다:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

정상 신호:

- 노드가 역할 `node` 에 대해 연결되고 페어링되어 있습니다.
- `nodes describe` 에 호출 중인 기능이 포함되어 있습니다.
- Exec 승인에 예상되는 모드/허용 목록이 표시됩니다.

## 포그라운드 요구 사항

`canvas.*`, `camera.*`, `screen.*` 는 iOS/Android 노드에서 포그라운드 전용입니다.

빠른 확인 및 해결:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE` 이 표시되면 노드 앱을 포그라운드로 전환한 후 다시 시도하십시오.

## 권한 매트릭스

| 기능                           | iOS                                       | Android                                     | macOS 노드 앱                             | 일반적인 실패 코드                     |
| ---------------------------- | ----------------------------------------- | ------------------------------------------- | -------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | 카메라 (+ 클립 오디오용 마이크)    | 카메라 (+ 클립 오디오용 마이크)      | 카메라 (+ 클립 오디오용 마이크) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 화면 녹화 (+ 마이크 선택 사항)    | 화면 캡처 프롬프트 (+ 마이크 선택 사항) | 화면 녹화                                  | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 사용 중 또는 항상 (모드에 따라 다름) | 모드에 따른 전경/백그라운드 위치                          | 위치 권한                                  | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | 해당 없음 (노드 호스트 경로)      | 해당 없음 (노드 호스트 경로)        | Exec 승인 필요                             | `SYSTEM_RUN_DENIED`            |

## 페어링 대 승인

이들은 서로 다른 게이트입니다:

1. **디바이스 페어링**: 이 노드가 Gateway(게이트웨이)에 연결할 수 있습니까?
2. **Exec 승인**: 이 노드가 특정 셸 명령을 실행할 수 있습니까?

빠른 확인:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

페어링이 누락된 경우 먼저 노드 디바이스를 승인하십시오.
페어링은 정상이나 `system.run` 이 실패하는 경우, exec 승인/허용 목록을 수정하십시오.

## 일반적인 노드 오류 코드

- `NODE_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드에 있음; 포그라운드로 전환하십시오.
- `CAMERA_DISABLED` → 노드 설정에서 카메라 토글이 비활성화됨.
- `*_PERMISSION_REQUIRED` → OS 권한이 누락되었거나 거부됨.
- `LOCATION_DISABLED` → 위치 모드가 꺼져 있음.
- `LOCATION_PERMISSION_REQUIRED` → 요청된 위치 모드가 부여되지 않음.
- `LOCATION_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드에 있으나 '사용 중' 권한만 존재함.
- `SYSTEM_RUN_DENIED: approval required` → exec 요청에 명시적 승인이 필요함.
- `SYSTEM_RUN_DENIED: allowlist miss` → 허용 목록 모드에 의해 명령이 차단됨.

## 빠른 복구 루프

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

여전히 해결되지 않으면:

- 디바이스 페어링을 다시 승인합니다.
- 노드 앱을 다시 엽니다 (포그라운드).
- OS 권한을 다시 부여합니다.
- exec 승인 정책을 재생성/조정합니다.

관련 문서:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
