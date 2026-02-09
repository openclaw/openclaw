---
summary: "`openclaw nodes`에 대한 CLI 참조 (목록/상태/승인/호출, 카메라/캔버스/화면)"
read_when:
  - 페어링된 노드 (카메라, 화면, 캔버스)를 관리할 때
  - 요청을 승인하거나 노드 명령을 호출해야 할 때
title: "nodes"
---

# `openclaw nodes`

페어링된 노드 (디바이스)를 관리하고 노드 기능을 호출합니다.

관련 항목:

- 노드 개요: [Nodes](/nodes)
- 카메라: [Camera nodes](/nodes/camera)
- 이미지: [Image nodes](/nodes/images)

공통 옵션:

- `--url`, `--token`, `--timeout`, `--json`

## 공통 명령

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

`nodes list`는 보류 중/페어링된 테이블을 출력합니다. 페어링된 행에는 가장 최근 연결 경과 시간 (Last Connect)이 포함됩니다.
현재 연결된 노드만 표시하려면 `--connected`를 사용하십시오. `--last-connected <duration>`를 사용하면
지정한 기간 내에 연결된 노드로 필터링할 수 있습니다 (예: `24h`, `7d`).

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

### Exec 스타일 기본값

`nodes run`는 모델의 exec 동작 (기본값 + 승인)을 반영합니다:

- `tools.exec.*`을 읽습니다 (`agents.list[].tools.exec.*` 오버라이드 포함).
- `system.run`를 호출하기 전에 exec 승인 (`exec.approval.request`)을 사용합니다.
- `tools.exec.node`가 설정된 경우 `--node`는 생략할 수 있습니다.
- `system.run`를 광고하는 노드가 필요합니다 (macOS 컴패니언 앱 또는 헤드리스 노드 호스트).

플래그:

- `--cwd <path>`: 작업 디렉토리.
- `--env <key=val>`: env 오버라이드 (반복 가능).
- `--command-timeout <ms>`: 명령 타임아웃.
- `--invoke-timeout <ms>`: 노드 호출 타임아웃 (기본값 `30000`).
- `--needs-screen-recording`: 화면 녹화 권한 필요.
- `--raw <command>`: 셸 문자열 실행 (`/bin/sh -lc` 또는 `cmd.exe /c`).
- `--agent <id>`: 에이전트 범위 승인/허용 목록 (구성된 에이전트가 기본값).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: 오버라이드.
