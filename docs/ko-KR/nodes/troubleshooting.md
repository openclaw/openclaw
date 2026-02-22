---
summary: "노드 페어링, 전경 요구사항, 권한 및 도구 실패 문제 해결"
read_when:
  - 노드가 연결되었지만 카메라/캔버스/화면/exec 도구가 실패하는 경우
  - 노드 페어링 대 승인에 대한 정신 모델이 필요한 경우
title: "노드 문제 해결"
---

# 노드 문제 해결

노드가 상태에 표시되지만 노드 도구가 실패할 때 이 페이지를 사용하세요.

## 명령어 사다리

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 노드별 검사를 실행하세요:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

양호한 신호:

- 노드는 연결되고 `node` 역할로 페어링 되었습니다.
- `nodes describe`에서 호출 중인 기능이 포함됩니다.
- Exec 승인에서 예상 모드/허용 목록을 보여줍니다.

## 전경 요구사항

`canvas.*`, `camera.*`, `screen.*`은 iOS/Android 노드에서 전경 전용입니다.

빠른 확인 및 수정:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE`이 보이면 노드 앱을 전경으로 가져와 다시 시도하세요.

## 권한 행렬

| 기능                         | iOS                                     | Android                                      | macOS 노드 앱                 | 일반적인 실패 코드              |
| ---------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | 카메라 (+ 오디오 클립을 위한 마이크)    | 카메라 (+ 오디오 클립을 위한 마이크)         | 카메라 (+ 오디오 클립을 위한 마이크) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 화면 녹화 (+ 마이크 선택 사항)          | 화면 캡처 프롬프트 (+ 마이크 선택 사항)       | 화면 녹화                      | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 사용 시 혹은 항상 (모드에 따라 다름)    | 모드를 기반으로 한 전경/배경 위치             | 위치 권한                      | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (노드 호스트 경로)                  | n/a (노드 호스트 경로)                       | Exec 승인 필요                 | `SYSTEM_RUN_DENIED`            |

## 페어링 대 승인

이것들은 서로 다른 게이트입니다:

1. **디바이스 페어링**: 이 노드가 게이트웨이에 연결될 수 있습니까?
2. **Exec 승인**: 이 노드가 특정 쉘 명령어를 실행할 수 있습니까?

빠른 확인:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

페어링이 누락된 경우 노드 디바이스를 먼저 승인하세요.
페어링이 정상인데 `system.run`이 실패하면 exec 승인/허용 목록을 수정하세요.

## 일반적인 노드 오류 코드

- `NODE_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드입니다. 전경으로 가져오세요.
- `CAMERA_DISABLED` → 노드 설정에서 카메라 토글이 비활성화되었습니다.
- `*_PERMISSION_REQUIRED` → 운영체제 권한이 누락/거부되었습니다.
- `LOCATION_DISABLED` → 위치 모드가 꺼져 있습니다.
- `LOCATION_PERMISSION_REQUIRED` → 요청한 위치 모드가 허가되지 않았습니다.
- `LOCATION_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드일 때 "사용 시" 권한만 있습니다.
- `SYSTEM_RUN_DENIED: approval required` → 실행 요청에는 명시적 승인이 필요합니다.
- `SYSTEM_RUN_DENIED: allowlist miss` → 명령어가 허용 목록 모드에 의해 차단되었습니다.

## 빠른 복구 루프

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

여전히 문제가 있으면:

- 디바이스 페어링을 다시 승인하세요.
- 노드 앱을 다시 열어 전경으로 가져오세요.
- 운영체제 권한을 다시 부여하세요.
- exec 승인 정책을 다시 만들거나 조정하세요.

관련 항목:

- [/nodes/index](/ko-KR/nodes/index)
- [/nodes/camera](/ko-KR/nodes/camera)
- [/nodes/location-command](/ko-KR/nodes/location-command)
- [/tools/exec-approvals](/ko-KR/tools/exec-approvals)
- [/gateway/pairing](/ko-KR/gateway/pairing)