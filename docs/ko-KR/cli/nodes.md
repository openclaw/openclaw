---
summary: "CLI reference for `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - You’re managing paired nodes (cameras, screen, canvas)
  - You need to approve requests or invoke node commands
title: "nodes"
x-i18n:
  source_hash: 23da6efdd659a82dbbc4afd18eb4ab1020a2892f69c28d610f912c8a799f734c
---

# `openclaw nodes`

페어링된 노드(장치)를 관리하고 노드 기능을 호출합니다.

관련 항목:

- 노드 개요: [노드](/nodes)
- 카메라: [카메라 노드](/nodes/camera)
- 이미지: [이미지 노드](/nodes/images)

일반적인 옵션:

- `--url`, `--token`, `--timeout`, `--json`

## 일반적인 명령

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

`nodes list` 보류/쌍 테이블을 인쇄합니다. 쌍을 이루는 행에는 가장 최근의 연결 기간(마지막 연결)이 포함됩니다.
현재 연결된 노드만 표시하려면 `--connected`를 사용하세요. `--last-connected <duration>`를 사용하여
일정 기간 내에 연결된 노드로 필터링합니다(예: `24h`, `7d`).

## 호출/실행

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

호출 플래그:

- `--params <json>`: JSON 객체 문자열(기본값 `{}`).
- `--invoke-timeout <ms>`: 노드 호출 시간 초과(기본값 `15000`).
- `--idempotency-key <key>`: 선택적 멱등성 키입니다.

### Exec 스타일 기본값

`nodes run`는 모델의 실행 동작을 반영합니다(기본값 + 승인):

- `tools.exec.*`를 읽습니다(`agents.list[].tools.exec.*`가 재정의됨).
- `system.run`를 호출하기 전에 실행 승인(`exec.approval.request`)을 사용합니다.
- `--node`는 `tools.exec.node` 설정 시 생략 가능합니다.
- `system.run`(macOS 도우미 앱 또는 헤드리스 노드 호스트)를 광고하는 노드가 필요합니다.

플래그:

- `--cwd <path>`: 작업 디렉터리.
- `--env <key=val>`: 환경 재정의(반복 가능).
- `--command-timeout <ms>`: 명령 시간이 초과되었습니다.
- `--invoke-timeout <ms>`: 노드 호출 시간 초과(기본값 `30000`).
- `--needs-screen-recording` : 화면 녹화 권한이 필요합니다.
- `--raw <command>`: 쉘 문자열(`/bin/sh -lc` 또는 `cmd.exe /c`)을 실행합니다.
- `--agent <id>`: 에이전트 범위 승인/허용 목록(기본값은 구성된 에이전트).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: 우선 적용됩니다.
