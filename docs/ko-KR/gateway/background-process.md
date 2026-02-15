---
summary: "Background exec execution and process management"
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
title: "Background Exec and Process Tool"
x-i18n:
  source_hash: e11a7d74a75000d6882f703693c2c49a2ecd3e730b6ec2b475ac402abde9e465
---

# 백그라운드 실행 + 프로세스 도구

OpenClaw는 `exec` 도구를 통해 쉘 명령을 실행하고 장기 실행 작업을 메모리에 유지합니다. `process` 도구는 이러한 백그라운드 세션을 관리합니다.

## 실행 도구

주요 매개변수:

- `command` (필수)
- `yieldMs` (기본값 10000): 이 지연 후 자동 배경 설정
- `background` (bool): 즉시 배경 설정
- `timeout` (초, 기본값 1800): 이 시간 초과 후 프로세스를 종료합니다.
- `elevated` (bool): 관리자 모드가 활성화/허용된 경우 호스트에서 실행됩니다.
- 실제 TTY가 필요하십니까? `pty: true`를 설정합니다.
- `workdir`, `env`

행동:

- 포그라운드는 리턴 출력을 직접 실행합니다.
- 백그라운드(명시적 또는 시간 초과)인 경우 도구는 `status: "running"` + `sessionId` 및 짧은 꼬리를 반환합니다.
- 출력은 세션이 폴링되거나 지워질 때까지 메모리에 유지됩니다.
- `process` 도구가 허용되지 않으면 `exec`는 동기식으로 실행되고 `yieldMs`/`background`를 무시합니다.

## 하위 프로세스 브리징

exec/프로세스 도구(예: CLI 다시 생성 또는 게이트웨이 도우미) 외부에서 장기 실행 하위 프로세스를 생성하는 경우 종료 신호가 전달되고 종료/오류 시 리스너가 분리되도록 하위 프로세스 브리지 도우미를 연결합니다. 이는 systemd에서 고아 프로세스를 방지하고 플랫폼 전체에서 종료 동작을 일관되게 유지합니다.

환경 재정의:

- `PI_BASH_YIELD_MS`: 기본 출력량(ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: 메모리 내 출력 캡(문자)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: 스트림당 stdout/stderr 한도(문자) 보류 중
- `PI_BASH_JOB_TTL_MS`: 완료된 세션의 TTL(ms, 1m~3h로 제한)

구성(선호):

- `tools.exec.backgroundMs` (기본값 10000)
- `tools.exec.timeoutSec` (기본값 1800)
- `tools.exec.cleanupMs` (기본값 1800000)
- `tools.exec.notifyOnExit` (기본값은 true): 시스템 이벤트를 대기열에 추가하고 백그라운드 실행이 종료될 때 하트비트를 요청합니다.

## 프로세스 도구

작업:

- `list`: 실행 중 + 완료된 세션
- `poll`: 세션에 대한 새 출력 배출(종료 상태도 보고)
- `log`: 집계된 출력 읽기 (`offset` + `limit` 지원)
- `write`: stdin 전송 (`data`, 선택 사항 `eof`)
- `kill`: 백그라운드 세션 종료
- `clear`: 완료된 세션을 메모리에서 제거합니다.
- `remove`: 실행 중이면 종료, 그렇지 않으면 완료되면 삭제

참고:

- 백그라운드 세션만 메모리에 나열/지속됩니다.
- 프로세스를 다시 시작하면 세션이 손실됩니다(디스크 지속성 없음).
- 세션 로그는 `process poll/log`를 실행하고 도구 결과를 기록하는 경우에만 채팅 기록에 저장됩니다.
- `process`는 에이전트별로 범위가 지정됩니다. 해당 에이전트가 시작한 세션만 ​​볼 수 있습니다.
- `process list`에는 빠른 스캔을 위해 파생된 `name`(명령어 동사 + 대상)가 포함되어 있습니다.
- `process log`는 라인 기반 `offset`/`limit`를 사용합니다(마지막 N 라인을 가져오려면 `offset` 생략).

## 예

긴 작업을 실행하고 나중에 폴링합니다.

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

백그라운드에서 즉시 시작:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

표준 입력 보내기:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
