---
summary: "백그라운드 exec 실행 및 프로세스 관리"
read_when:
  - 백그라운드 exec 동작을 추가하거나 수정할 때
  - 장시간 실행되는 exec 작업을 디버깅할 때
title: "백그라운드 Exec 및 프로세스 도구"
---

# 백그라운드 Exec + 프로세스 도구

OpenClaw 는 `exec` 도구를 통해 셸 명령을 실행하고, 장시간 실행되는 작업을 메모리에 유지합니다. `process` 도구는 이러한 백그라운드 세션을 관리합니다.

## exec 도구

주요 매개변수:

- `command` (필수)
- `yieldMs` (기본값 10000): 이 지연 이후 자동으로 백그라운드 처리
- `background` (bool): 즉시 백그라운드로 실행
- `timeout` (초, 기본값 1800): 이 타임아웃 이후 프로세스 종료
- `elevated` (bool): 권한 상승 모드가 활성화/허용된 경우 호스트에서 실행
- 실제 TTY 가 필요한가요? 실제 TTY 가 필요한 경우 `pty: true` 을 설정하십시오.
- `workdir`, `env`

동작:

- 포그라운드 실행은 출력을 직접 반환합니다.
- 백그라운드로 전환되면(명시적 또는 타임아웃), 도구는 `status: "running"` + `sessionId` 와 짧은 tail 을 반환합니다.
- 출력은 세션이 폴링되거나 정리될 때까지 메모리에 유지됩니다.
- `process` 도구가 허용되지 않은 경우, `exec` 는 동기적으로 실행되며 `yieldMs`/`background` 를 무시합니다.

## 자식 프로세스 브리징

exec/프로세스 도구 외부에서 장시간 실행되는 자식 프로세스를 생성할 때(예: CLI 재시작 또는 게이트웨이 헬퍼), 종료 신호가 전달되고 종료/오류 시 리스너가 분리되도록 자식 프로세스 브리지 헬퍼를 연결하십시오. 이는 systemd 에서 고아 프로세스를 방지하고 플랫폼 전반에서 종료 동작의 일관성을 유지합니다.

환경 변수 재정의:

- `PI_BASH_YIELD_MS`: 기본 yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: 메모리 내 출력 상한 (문자 수)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: 스트림당 대기 stdout/stderr 상한 (문자 수)
- `PI_BASH_JOB_TTL_MS`: 완료된 세션의 TTL (ms, 1분–3시간으로 제한)

구성(권장):

- `tools.exec.backgroundMs` (기본값 10000)
- `tools.exec.timeoutSec` (기본값 1800)
- `tools.exec.cleanupMs` (기본값 1800000)
- `tools.exec.notifyOnExit` (기본값 true): 백그라운드 exec 가 종료되면 시스템 이벤트를 큐에 추가하고 요청 하트비트를 전송합니다.

## process 도구

작업:

- `list`: 실행 중 + 완료된 세션
- `poll`: 세션의 새 출력을 드레인(종료 상태도 보고)
- `log`: 집계된 출력 읽기(`offset` + `limit` 지원)
- `write`: stdin 전송(`data`, 선택적 `eof`)
- `kill`: 백그라운드 세션 종료
- `clear`: 완료된 세션을 메모리에서 제거
- `remove`: 실행 중이면 종료, 그렇지 않으면 완료된 경우 정리

참고:

- 백그라운드로 전환된 세션만 나열되며 메모리에 유지됩니다.
- 프로세스 재시작 시 세션은 손실됩니다(디스크 영속성 없음).
- 세션 로그는 `process poll/log` 를 실행하고 도구 결과가 기록된 경우에만 채팅 기록에 저장됩니다.
- `process` 는 에이전트별 범위로 적용되며, 해당 에이전트가 시작한 세션만 볼 수 있습니다.
- `process list` 에는 빠른 확인을 위한 파생 `name` (명령 동사 + 대상)가 포함됩니다.
- `process log` 는 라인 기반 `offset`/`limit` 를 사용합니다(`offset` 을 생략하면 마지막 N 줄을 가져옵니다).

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
