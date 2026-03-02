---
summary: "노드 pairing, 포그라운드 요구 사항, 권한 및 도구 실패 문제 해결"
read_when:
  - 노드가 연결되었지만 카메라/캔버스/화면/실행 도구가 실패할 때
  - 노드 pairing vs 승인 정신 모델이 필요할 때
title: "노드 문제 해결"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: nodes/troubleshooting.md
workflow: 15
---

# 노드 문제 해결

노드가 상태에 표시되지만 노드 도구가 실패할 때 이 페이지를 사용합니다.

## 커맨드 래더

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그 다음 노드 특정 확인을 실행:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

건강한 신호:

- 노드가 연결되고 역할 `node`에 대해 쌍을 이룸.
- `nodes describe`는 호출하는 기능을 포함.
- 실행 승인이 예상 모드/허용 목록을 표시.

## 포그라운드 요구 사항

`canvas.*`, `camera.*` 및 `screen.*`은 iOS/Android 노드에서 포그라운드만.

빠른 확인 및 수정:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE`이 보이면 노드 앱을 포그라운드로 가져오고 재시도합니다.

## 권한 매트릭스

| 기능                         | iOS                                 | Android                                      | macOS 노드 앱                 | 일반적 실패 코드               |
| ---------------------------- | ----------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera (+ mic for clip audio)       | Camera (+ mic for clip audio)                | Camera (+ mic for clip audio) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Screen Recording (+ mic optional)   | Screen capture prompt (+ mic optional)       | Screen Recording              | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using or Always (mode에 따라) | Foreground/Background location based on mode | Location permission           | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (노드 호스트 경로)              | n/a (노드 호스트 경로)                       | Exec 승인 필요                | `SYSTEM_RUN_DENIED`            |

## Pairing vs 승인

이들은 다른 제어입니다:

1. **Device pairing**: 이 노드가 Gateway에 연결할 수 있는가?
2. **Exec approvals**: 이 노드가 특정 셸 커맨드를 실행할 수 있는가?

빠른 확인:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Pairing이 누락되면 노드 장치를 먼저 승인합니다.
Pairing이 있지만 `system.run`이 실패하면 실행 승인/허용 목록을 수정합니다.

## 공통 노드 오류 코드

- `NODE_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드됨; 포그라운드로 가져옵니다.
- `CAMERA_DISABLED` → 노드 설정에서 카메라 전환이 비활성화됨.
- `*_PERMISSION_REQUIRED` → OS 권한 누락/거부.
- `LOCATION_DISABLED` → 위치 모드가 꺼짐.
- `LOCATION_PERMISSION_REQUIRED` → 요청된 위치 모드가 부여되지 않음.
- `LOCATION_BACKGROUND_UNAVAILABLE` → 앱이 백그라운드이지만 While Using 권한만 존재.
- `SYSTEM_RUN_DENIED: approval required` → 실행 요청에 명시적 승인 필요.
- `SYSTEM_RUN_DENIED: allowlist miss` → 허용 목록 모드에서 차단된 커맨드.
  Windows 노드 호스트에서 `cmd.exe /c ...`와 같은 셸 래퍼 형식은 허용 목록 모드에서 승인 없이 허용 목록 누락으로 처리됩니다.

## 빠른 복구 루프

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

여전히 막히면:

- 장치 pairing 재승인.
- 노드 앱 다시 열기(포그라운드).
- OS 권한 재부여.
- 실행 승인 정책 재생성/조정.

관련:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
