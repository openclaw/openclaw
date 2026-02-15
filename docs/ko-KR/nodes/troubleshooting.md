---
summary: "Troubleshoot node pairing, foreground requirements, permissions, and tool failures"
read_when:
  - Node is connected but camera/canvas/screen/exec tools fail
  - You need the node pairing versus approvals mental model
title: "Node Troubleshooting"
x-i18n:
  source_hash: 5c40d298c9feaf8eb02cc7c6c929d9c9d5d5f93519d3c2ea8c10775db10c76dd
---

# 노드 문제 해결

노드가 상태에 표시되지만 노드 도구가 실패하는 경우 이 페이지를 사용하세요.

## 명령 사다리

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 노드별 검사를 실행합니다.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

건강한 신호:

- 노드가 `node` 역할에 연결되어 페어링되었습니다.
- `nodes describe`에는 호출 중인 기능이 포함됩니다.
- Exec 승인에는 예상 모드/허용 목록이 표시됩니다.

## 전경 요구 사항

`canvas.*`, `camera.*` 및 `screen.*`는 iOS/Android 노드에서만 포그라운드입니다.

빠른 확인 및 수정:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE`이 표시되면 노드 앱을 포그라운드로 가져와 다시 시도하세요.

## 권한 매트릭스

| 능력                         | iOS                                 | 안드로이드                        | macOS 노드 앱                  | 일반적인 오류 코드             |
| ---------------------------- | ----------------------------------- | --------------------------------- | ------------------------------ | ------------------------------ |
| `camera.snap`, `camera.clip` | 카메라(클립 오디오용 + 마이크)      | 카메라(클립 오디오용 + 마이크)    | 카메라(클립 오디오용 + 마이크) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 화면 녹화(+ 마이크 옵션)            | 화면 캡처 프롬프트(+ 마이크 옵션) | 화면 녹화                      | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 사용 중 또는 항상(모드에 따라 다름) | 모드에 따른 전경/배경 위치        | 위치 권한                      | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | 해당 사항 없음(노드 호스트 경로)    | 해당 사항 없음(노드 호스트 경로)  | 임원 승인 필요                 | `SYSTEM_RUN_DENIED`            |

## 페어링 대 승인

다음은 서로 다른 게이트입니다.

1. **장치 페어링**: 이 노드를 게이트웨이에 연결할 수 있나요?
2. **실행 승인**: 이 노드가 특정 셸 명령을 실행할 수 있습니까?

빠른 점검:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

페어링이 누락된 경우 먼저 노드 장치를 승인하세요.
페어링은 양호하지만 `system.run` 실패하는 경우 실행 승인/허용 목록을 수정하세요.

## 공통 노드 오류 코드

- `NODE_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드 상태입니다. 그것을 전경으로 가져 오십시오.
- `CAMERA_DISABLED` → 노드 설정에서 카메라 토글이 비활성화되었습니다.
- `*_PERMISSION_REQUIRED` → OS 권한이 없거나 거부되었습니다.
- `LOCATION_DISABLED` → 위치 모드가 꺼져 있습니다.
- `LOCATION_PERMISSION_REQUIRED` → 요청한 위치 모드가 허용되지 않습니다.
- `LOCATION_BACKGROUND_UNAVAILABLE` → 앱은 백그라운드 상태이지만 사용 중 권한만 존재합니다.
- `SYSTEM_RUN_DENIED: approval required` → 실행 요청에는 명시적인 승인이 필요합니다.
- `SYSTEM_RUN_DENIED: allowlist miss` → 허용 목록 모드에 의해 차단된 명령입니다.

## 빠른 복구 루프

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

여전히 붙어 있는 경우:

- 장치 페어링을 다시 승인하십시오.
- 노드 앱(포그라운드)을 다시 엽니다.
- OS 권한을 다시 부여합니다.
- 실행 승인 정책을 다시 생성/조정합니다.

관련 항목:

- [/노드/인덱스](/nodes/index)
- [/노드/카메라](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/게이트웨이/페어링](/gateway/pairing)
