---
summary: "백그라운드 exec 실행 및 프로세스 관리"
read_when:
  - 백그라운드 exec 동작을 추가하거나 수정할 때
  - 장기 실행 exec 작업을 디버깅할 때
title: "백그라운드 Exec 및 프로세스 도구"
x-i18n:
  source_path: docs/gateway/background-process.md
---

# 백그라운드 Exec + 프로세스 도구

OpenClaw은 `exec` 도구를 통해 셸 명령을 실행하고 장기 실행 작업을 메모리에 유지합니다. `process` 도구는 이러한 백그라운드 세션을 관리합니다.

## exec 도구

주요 매개변수:

- `command` (필수)
- `yieldMs` (기본값 10000): 이 지연 후 자동 백그라운드 전환
- `background` (bool): 즉시 백그라운드 전환
- `timeout` (초, 기본값 1800): 이 시간 초과 후 프로세스 종료
- `elevated` (bool): 권한 상승 모드가 활성화/허용된 경우 호스트에서 실행
- 실제 TTY가 필요하면 `pty: true`를 설정합니다.
- `workdir`, `env`

동작:

- 포그라운드 실행은 출력을 직접 반환합니다.
- 백그라운드 전환 시 (명시적 또는 시간 초과), 도구는 `status: "running"` + `sessionId`와 짧은 tail을 반환합니다.
- 출력은 세션이 폴링되거나 삭제될 때까지 메모리에 유지됩니다.
- `process` 도구가 비허용이면, `exec`은 동기적으로 실행되며 `yieldMs`/`background`를 무시합니다.
- 생성된 exec 명령은 컨텍스트 인식 셸/프로필 규칙을 위해 `OPENCLAW_SHELL=exec`를 받습니다.

## 자식 프로세스 브릿징

exec/process 도구 외부에서 장기 실행 자식 프로세스를 생성할 때 (예: CLI 리스폰 또는 Gateway 헬퍼), 자식 프로세스 브릿지 헬퍼를 연결하여 종료 시그널이 전달되고 종료/오류 시 리스너가 분리되도록 합니다. 이를 통해 systemd에서 고아 프로세스를 방지하고 플랫폼 간에 종료 동작을 일관되게 유지합니다.

환경 오버라이드:

- `PI_BASH_YIELD_MS`: 기본 yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: 메모리 내 출력 상한 (chars)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: 스트림별 대기 중인 stdout/stderr 상한 (chars)
- `PI_BASH_JOB_TTL_MS`: 완료된 세션의 TTL (ms, 1분-3시간 범위)

설정 (권장):

- `tools.exec.backgroundMs` (기본값 10000)
- `tools.exec.timeoutSec` (기본값 1800)
- `tools.exec.cleanupMs` (기본값 1800000)
- `tools.exec.notifyOnExit` (기본값 true): 백그라운드 exec 종료 시 시스템 이벤트 큐에 넣기 + 하트비트 요청.
- `tools.exec.notifyOnExitEmptySuccess` (기본값 false): true일 때 출력이 없는 성공적인 백그라운드 실행에 대해서도 완료 이벤트를 큐에 넣습니다.

## process 도구

액션:

- `list`: 실행 중 + 완료된 세션
- `poll`: 세션의 새 출력 드레인 (종료 상태도 보고)
- `log`: 집계된 출력 읽기 (`offset` + `limit` 지원)
- `write`: stdin 전송 (`data`, 선택적 `eof`)
- `kill`: 백그라운드 세션 종료
- `clear`: 완료된 세션을 메모리에서 제거
- `remove`: 실행 중이면 kill, 완료되었으면 clear

참고:

- 백그라운드된 세션만 메모리에 나열/유지됩니다.
- 프로세스 재시작 시 세션이 손실됩니다 (디스크 영속성 없음).
- 세션 로그는 `process poll/log`를 실행하고 도구 결과가 기록되는 경우에만 채팅 기록에 저장됩니다.
- `process`는 에이전트별 범위입니다. 해당 에이전트가 시작한 세션만 볼 수 있습니다.
- `process list`에는 빠른 스캔을 위해 파생된 `name` (명령 동사 + 대상)이 포함됩니다.
- `process log`는 줄 기반 `offset`/`limit`을 사용합니다.
- `offset`과 `limit` 모두 생략되면, 마지막 200줄을 반환하고 페이징 힌트를 포함합니다.
- `offset`이 제공되고 `limit`이 생략되면, `offset`부터 끝까지 반환합니다 (200으로 제한되지 않음).

## 예시

장기 작업을 실행하고 나중에 폴링:

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
