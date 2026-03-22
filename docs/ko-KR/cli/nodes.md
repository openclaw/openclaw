---
summary: "`openclaw nodes` CLI 레퍼런스 (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - 페어링된 노드를 관리할 때 (카메라, 스크린, 캔버스)
  - 요청을 승인하거나 노드 명령을 호출해야 할 때
title: "nodes"
x-i18n:
  source_path: "docs/cli/nodes.md"
---

# `openclaw nodes`

페어링된 노드 (디바이스)를 관리하고 노드 기능을 호출합니다.

관련 문서:

- 노드 개요: [Nodes](/nodes)
- 카메라: [Camera nodes](/nodes/camera)
- 이미지: [Image nodes](/nodes/images)

공통 옵션:

- `--url`, `--token`, `--timeout`, `--json`

## 주요 명령어

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

`nodes list`는 대기 중/페어링된 테이블을 출력합니다. 페어링된 행에는 가장 최근 연결 경과 시간 (Last Connect)이 포함됩니다.
`--connected`를 사용하면 현재 연결된 노드만 표시합니다. `--last-connected <duration>`을 사용하면 지정된 기간 내에 연결된 노드만 필터링합니다 (예: `24h`, `7d`).

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke 플래그:

- `--params <json>`: JSON 객체 문자열 (기본값 `{}`).
- `--invoke-timeout <ms>`: 노드 호출 타임아웃 (기본값 `15000`).
- `--idempotency-key <key>`: 선택적 멱등성 키.

### 실행 스타일 기본값

`nodes run`은 모델의 실행 동작 (기본값 + 승인)을 미러링합니다:

- `tools.exec.*` (및 `agents.list[].tools.exec.*` 오버라이드)를 읽습니다.
- `system.run` 호출 전에 실행 승인 (`exec.approval.request`)을 사용합니다.
- `tools.exec.node`가 설정된 경우 `--node`를 생략할 수 있습니다.
- `system.run`을 공개하는 노드가 필요합니다 (macOS 컴패니언 앱 또는 헤드리스 노드 호스트).

플래그:

- `--cwd <path>`: 작업 디렉터리.
- `--env <key=val>`: 환경변수 재정의 (반복 가능). 참고: 노드 호스트는 `PATH` 재정의를 무시합니다 (또한 `tools.exec.pathPrepend`는 노드 호스트에 적용되지 않습니다).
- `--command-timeout <ms>`: 명령 타임아웃.
- `--invoke-timeout <ms>`: 노드 호출 타임아웃 (기본값 `30000`).
- `--needs-screen-recording`: 화면 녹화 권한 필요.
- `--raw <command>`: 셸 문자열 실행 (`/bin/sh -lc` 또는 `cmd.exe /c`).
  Windows 노드 호스트의 허용 목록 모드에서 `cmd.exe /c` 셸 래퍼 실행은 승인이 필요합니다 (허용 목록 항목만으로는 래퍼 형태를 자동 허용하지 않습니다).
- `--agent <id>`: 에이전트 범위의 승인/허용 목록 (기본값: 설정된 에이전트).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: 재정의.
