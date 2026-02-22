---
summary: "백그라운드 exec 실행 및 프로세스 관리"
read_when:
  - 백그라운드 exec 동작 추가 또는 수정 시
  - 장시간 실행되는 exec 작업 디버깅 시
title: "백그라운드 Exec 및 프로세스 도구"
---

# 백그라운드 Exec + 프로세스 도구

OpenClaw는 `exec` 도구를 통해 셸 명령을 실행하고 장시간 실행되는 작업을 메모리에 유지합니다. `process` 도구는 이러한 백그라운드 세션을 관리합니다.

## exec 도구

주요 매개변수:

- `command` (필수)
- `yieldMs` (기본값 10000): 이 지연 후 자동 백그라운드로 전환
- `background` (bool): 즉시 백그라운드 처리
- `timeout` (초, 기본값 1800): 이 시간 초과 후 프로세스를 종료
- `elevated` (bool): 상승 모드가 활성화/허용된 경우 호스트에서 실행
- 실제 TTY가 필요합니까? `pty: true`로 설정하십시오.
- `workdir`, `env`

동작:

- 포그라운드 실행은 출력을 직접 반환합니다.
- 백그라운드 전환 시 (명시적 또는 시간 초과), 도구는 `status: "running"` + `sessionId`와 짧은 tail을 반환합니다.
- 출력은 세션이 폴링되거나 지워질 때까지 메모리에 유지됩니다.
- `process` 도구가 허용되지 않으면, `exec`는 동기식으로 실행되며 `yieldMs`/`background`를 무시합니다.

## 하위 프로세스 브리징

exec/process 도구 외부에서 장시간 실행되는 하위 프로세스를 생성할 때 (예: CLI 리스폰 또는 게이트웨이 헬퍼), 하위 프로세스 브릿지 헬퍼를 부착하여 종료 신호가 전달되고 종료/오류 시 리스너가 분리되도록 합니다. 이렇게 하면 시스템 접속에서 고아 프로세스를 방지하고 플랫폼 간 종료 동작을 일관되게 유지할 수 있습니다.

환경 변수 재정의:

- `PI_BASH_YIELD_MS`: 기본 수율 (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: 메모리 내 출력 제한 (문자)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: 스트림당 대기 중인 stdout/stderr 제한 (문자)
- `PI_BASH_JOB_TTL_MS`: 종료된 세션의 TTL (ms, 1m–3h로 제한됨)

설정 (선호됨):

- `tools.exec.backgroundMs` (기본값 10000)
- `tools.exec.timeoutSec` (기본값 1800)
- `tools.exec.cleanupMs` (기본값 1800000)
- `tools.exec.notifyOnExit` (기본값 true): 백그라운드 exec 종료 시 시스템 이벤트 대기열에 추가 + 하트비트 요청.
- `tools.exec.notifyOnExitEmptySuccess` (기본값 false): true로 설정하면, 출력을 생성하지 않은 성공적인 백그라운드 실행에도 완료 이벤트를 대기열에 추가.

## process 도구

작업:

- `list`: 실행 중 + 종료된 세션
- `poll`: 세션의 새로운 출력 드레인 (종료 상태도 보고)
- `log`: 집계된 출력 읽기 (지원 `offset` + `limit`)
- `write`: 표준 입력 전송 (`data`, 선택적 `eof`)
- `kill`: 백그라운드 세션 종료
- `clear`: 메모리에서 종료된 세션 제거
- `remove`: 실행 중인 경우 종료, 그렇지 않으면 종료된 경우 제거

주의사항:

- 백그라운드 처리된 세션만 메모리에 나열/유지됩니다.
- 프로세스가 재시작되면 세션이 손실됩니다 (디스크 지속성 없음).
- 세션 로그는 `process poll/log` 실행 및 도구 결과가 기록된 경우에만 채팅 기록에 저장됩니다.
- `process`는 에이전트별로 범위가 지정됩니다; 해당 에이전트가 시작한 세션만 봅니다.
- `process list`는 빠른 검색을 위한 파생 `name` (명령 동사 + 대상)을 포함합니다.
- `process log`는 라인 기반 `offset`/`limit`을 사용합니다.
- `offset`과 `limit` 모두 생략시, 마지막 200줄과 페이징 힌트를 포함하여 반환합니다.
- `offset`이 제공되고 `limit`이 생략되면, `offset`부터 끝까지 반환합니다 (200으로 제한되지 않음).

## 예시

긴 작업 실행 후 나중에 폴링:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

즉시 백그라운드 시작:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

표준 입력 전송:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```