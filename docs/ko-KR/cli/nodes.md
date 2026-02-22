---
summary: "CLI reference for `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - You’re managing paired nodes (cameras, screen, canvas)
  - You need to approve requests or invoke node commands
title: "nodes"
---

# `openclaw nodes`

연결된 노드(장치)를 관리하고 노드 기능을 호출합니다.

관련 항목:

- 노드 개요: [Nodes](/ko-KR/nodes)
- 카메라: [Camera nodes](/ko-KR/nodes/camera)
- 이미지: [Image nodes](/ko-KR/nodes/images)

일반 옵션:

- `--url`, `--token`, `--timeout`, `--json`

## 일반 명령어

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list`는 대기 중/연결된 테이블을 출력합니다. 연결된 행에는 가장 최근 연결된 시각 나이(Last Connect)가 포함됩니다.
`--connected`를 사용하여 현재 연결된 노드만 표시하세요. `--last-connected <duration>`을 사용하여 
지정한 기간 내에 연결된 노드를 필터링할 수 있습니다 (예: `24h`, `7d`).

## 호출 / 실행

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

호출 플래그:

- `--params <json>`: JSON 객체 문자열 (기본값 `{}`). 
- `--invoke-timeout <ms>`: 노드 호출 타임아웃 (기본값 `15000`).
- `--idempotency-key <key>`: 선택적 멱등성 키.

### 실행 스타일 기본값

`nodes run`은 모델의 실행 동작을 반영합니다 (기본값 + 승인):

- `tools.exec.*`를 읽습니다 (`agents.list[].tools.exec.*` 오버라이드 포함).
- `system.run`을 호출하기 전에 실행 승인을 사용합니다 (`exec.approval.request`).
- `tools.exec.node`가 설정된 경우 `--node`를 생략할 수 있습니다.
- `system.run`을 광고하는 노드가 필요합니다 (macOS 동반 앱 또는 헤드리스 노드 호스트).

플래그:

- `--cwd <path>`: 작업 디렉터리.
- `--env <key=val>`: 환경 변수 오버라이드 (반복 가능). 주의: 노드 호스트는 `PATH` 오버라이드를 무시하며, 노드 호스트에는 `tools.exec.pathPrepend`가 적용되지 않습니다.
- `--command-timeout <ms>`: 명령어 타임아웃.
- `--invoke-timeout <ms>`: 노드 호출 타임아웃 (기본값 `30000`).
- `--needs-screen-recording`: 화면 녹화 권한 필요.
- `--raw <command>`: 쉘 문자열 실행 (`/bin/sh -lc` 또는 `cmd.exe /c`).
- `--agent <id>`: 에이전트 범위의 승인/허용 목록 (기본값은 설정된 에이전트).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: 오버라이드.