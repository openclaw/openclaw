---
summary: "백그라운드 exec 실행 및 프로세스 관리"
read_when:
  - 백그라운드 exec 동작 추가 또는 수정
  - 장시간 실행되는 exec 작업 디버깅
title: "백그라운드 Exec 및 Process 도구"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/background-process.md
  workflow: 15
---

# 백그라운드 Exec + Process 도구

OpenClaw는 `exec` 도구를 통해 셸 명령을 실행하고 장시간 실행되는 작업을 메모리에 유지합니다. `process` 도구는 해당 백그라운드 세션을 관리합니다.

## exec 도구

주요 매개변수:

- `command` (필수)
- `yieldMs` (기본값 10000): 이 지연 후 자동 백그라운드로 전환
- `background` (bool): 즉시 백그라운드로 실행
- `timeout` (초, 기본값 1800): 이 시간 후 프로세스 종료
- `elevated` (bool): 승격된 모드가 활성화/허용되는 경우 호스트에서 실행
- 실제 TTY가 필요합니까? `pty: true` 설정
- `workdir`, `env`

동작:

- 포그라운드 실행은 직접 출력을 반환합니다.
- 백그라운드로 전환되면(명시적 또는 시간 초과), 도구는 `status: "running"` + `sessionId` 및 짧은 꼬리를 반환합니다.
- 출력은 세션이 폴링되거나 지워질 때까지 메모리에 유지됩니다.
- `process` 도구가 허용되지 않으면, `exec`는 동기적으로 실행되고 `yieldMs`/`background`를 무시합니다.

## 자식 프로세스 브리징

exec/process 도구 외부에서 장시간 실행되는 자식 프로세스를 생성할 때(예: CLI 재시작 또는 게이트웨이 헬퍼), 자식 프로세스 브리지 헬퍼를 연결하여 종료 신호가 전달되고 리스너가 종료/오류 시 분리되도록 합니다. 이는 systemd에서 고아 프로세스를 방지하고 플랫폼 간 종료 동작을 일관되게 유지합니다.

환경 재정의:

- `PI_BASH_YIELD_MS`: 기본 수율(ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: 메모리 내 출력 상한(문자)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: 스트림당 대기 중인 stdout/stderr 상한(문자)
- `PI_BASH_JOB_TTL_MS`: 완료된 세션의 TTL(ms, 1분~3시간 범위)

설정(권장):

- `tools.exec.backgroundMs` (기본값 10000)
- `tools.exec.timeoutSec` (기본값 1800)
- `tools.exec.cleanupMs` (기본값 1800000)
- `tools.exec.notifyOnExit` (기본값 true): 백그라운드 exec가 종료될 때 시스템 이벤트를 큐에 추가하고 하트비트를 요청합니다.
- `tools.exec.notifyOnExitEmptySuccess` (기본값 false): true일 때 출력이 없는 성공적인 백그라운드 실행에 대해서도 완료 이벤트를 큐에 추가합니다.

## process 도구

작업:

- `list`: 실행 중 및 완료된 세션
- `poll`: 세션의 새 출력 드레인(종료 상태도 보고)
- `log`: 집계된 출력 읽기 (`offset` + `limit` 지원)
- `write`: stdin 전송 (`data`, 선택사항 `eof`)
- `kill`: 백그라운드 세션 종료
- `clear`: 완료된 세션을 메모리에서 제거
- `remove`: 실행 중이면 종료, 완료되었으면 지우기

참고:

- 백그라운드 세션만 메모리에 나열/유지됩니다.
- 프로세스 재시작 시 세션이 손실됩니다(디스크 지속성 없음).
- 세션 로그는 `process poll/log`를 실행하고 도구 결과를 기록하는 경우에만 채팅 기록에 저장됩니다.
- `process`는 에이전트별로 범위가 지정됩니다. 해당 에이전트가 시작한 세션만 봅니다.
- `process list`는 빠른 스캔을 위해 파생된 `name` (명령 동사 + 대상)을 포함합니다.
- `process log`는 라인 기반 `offset`/`limit`을 사용합니다.
- `offset` 및 `limit`이 모두 생략되면 마지막 200줄을 반환하고 페이징 힌트를 포함합니다.
- `offset`이 제공되고 `limit`이 생략되면 `offset`부터 끝까지 반환합니다(200으로 제한되지 않음).

## 예제

장시간 작업을 실행하고 나중에 폴링:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

즉시 백그라운드로 시작:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdin 전송:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
