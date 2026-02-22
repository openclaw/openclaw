---
summary: "명시적 소유권, 통합된 라이프사이클, 결정적 정리를 통한 신뢰할 수 있는 상호작용 프로세스 감독 (PTY + 비-PTY)을 위한 프로덕션 계획"
owner: "openclaw"
status: "진행 중"
last_updated: "2026-02-15"
title: "PTY 및 프로세스 감독 계획"
---

# PTY 및 프로세스 감독 계획

## 1. 문제 및 목표

다음 분야 전반에 걸쳐 장기 실행 명령어 수행을 위한 신뢰할 수 있는 하나의 라이프사이클이 필요합니다:

- `exec` 전경 모드 실행
- `exec` 백그라운드 실행
- `process` 후속 작업 (`poll`, `log`, `send-keys`, `paste`, `submit`, `kill`, `remove`)
- CLI 에이전트 실행기 하위 프로세스

목표는 PTY를 지원하는 것만이 아닙니다. 목표는 예측 가능한 소유권, 취소, 타임아웃 및 안전하지 않은 프로세스 매칭 휴리스틱 없이 정리를 포함하는 것입니다.

## 2. 범위 및 경계

- 구현을 `src/process/supervisor` 내부에 유지합니다.
- 이를 위한 새로운 패키지를 생성하지 않습니다.
- 실용적인 경우 현재 동작 호환성을 유지합니다.
- 터미널 재생 또는 tmux 스타일 세션 지속성으로 범위를 확장하지 않습니다.

## 3. 이 브랜치에서 구현됨

### 이미 존재하는 감독자 기본 설정

- `src/process/supervisor/*` 내에 감독자 모듈이 존재합니다.
- Exec 런타임과 CLI 실행기는 이미 감독자 생성 및 대기를 거칩니다.
- 레지스트리 완료는 멱등입니다.

### 완료된 이번 작업

1. 명시적 PTY 명령 계약

- `SpawnInput`은 이제 `src/process/supervisor/types.ts` 내에서 구별된 유니언입니다.
- PTY 실행은 일반 `argv`를 재사용하는 대신 `ptyCommand`가 필요합니다.
- 감독자는 더 이상 `src/process/supervisor/supervisor.ts` 내에서 argv 조인을 통해 PTY 명령 문자열을 재구성하지 않습니다.
- Exec 런타임은 이제 `src/agents/bash-tools.exec-runtime.ts` 내에서 직접 `ptyCommand`를 전달합니다.

2. 프로세스 레이어 타입 분리

- 감독자 타입은 더 이상 에이전트에서 `SessionStdin`을 가져오지 않습니다.
- 프로세스 로컬 표준 입력 계약은 `src/process/supervisor/types.ts` (`ManagedRunStdin`)에 존재합니다.
- 어댑터는 이제 프로세스 레벨 타입에만 의존합니다:
  - `src/process/supervisor/adapters/child.ts`
  - `src/process/supervisor/adapters/pty.ts`

3. 프로세스 도구 라이프사이클 소유권 개선

- `src/agents/bash-tools.process.ts`는 이제 먼저 감독자를 통해 취소를 요청합니다.
- `process kill/remove`는 이제 감독자 조회가 실패할 때 프로세스 트리 대체 종료를 사용합니다.
- `remove`는 종료 요청 직후 실행 중인 세션 항목을 삭제하여 결정적인 제거 동작을 유지합니다.

4. 단일 소스 감시자 기본값

- `src/agents/cli-watchdog-defaults.ts`에 공유 기본값을 추가했습니다.
- `src/agents/cli-backends.ts`가 공유 기본값을 사용합니다.
- `src/agents/cli-runner/reliability.ts`도 동일한 공유 기본값을 사용합니다.

5. 사용하지 않는 도우미 정리

- `src/agents/bash-tools.shared.ts`에서 사용하지 않는 `killSession` 도우미 경로를 제거했습니다.

6. 직접 감독자 경로 테스트 추가

- `src/agents/bash-tools.process.supervisor.test.ts`를 추가하여 감독자 취소를 통한 kill 및 remove 라우팅을 다룹니다.

7. 신뢰성 간격 수정 완료

- `src/agents/bash-tools.process.ts`는 이제 감독자 조회 실패 시 실제 OS 레벨 프로세스 종료로 돌아갑니다.
- `src/process/supervisor/adapters/child.ts`는 기본 취소/타임아웃 종료 경로에 프로세스 트리 종료 의미를 사용합니다.
- `src/process/kill-tree.ts`에 공유 프로세스 트리 유틸리티를 추가했습니다.

8. PTY 계약 에지 케이스 커버리지 추가

- `src/process/supervisor/supervisor.pty-command.test.ts`를 추가하여 문자 그대로 PTY 명령 전달 및 빈 명령 거부를 테스트합니다.
- `src/process/supervisor/adapters/child.test.ts`를 추가하여 자식 어댑터 취소에서 프로세스 트리 kill 동작을 테스트합니다.

## 4. 남은 간격 및 결정

### 신뢰성 상태

이번 작업의 두 가지 필요한 신뢰성 간격은 이제 닫혔습니다:

- `process kill/remove`는 이제 감독자 조회 실패 시 실제 OS 종료 대체를 갖습니다.
- 자식 취소/타임아웃은 이제 기본 종료 경로에 프로세스 트리 종료 의미를 사용합니다.
- 두 가지 동작에 대한 리그레션 테스트가 추가되었습니다.

### 내구성 및 시작 조정

재시작 동작은 이제 메모리 내 라이프사이클만으로 명시적 정의됩니다.

- `reconcileOrphans()`는 설계 상 `src/process/supervisor/supervisor.ts`에서 아무 작업도 하지 않습니다.
- 프로세스 재시작 후 활동 실행은 복구되지 않습니다.
- 이 구현 패스에서는 부분 지속성 위험을 피하기 위해 이 경계가 의도적입니다.

### 유지 보수 후속 작업

1. `src/agents/bash-tools.exec-runtime.ts`의 `runExecProcess`는 여전히 여러 책임을 처리하며, 후속 작업에서 집중된 도우미로 분할될 수 있습니다.

## 5. 구현 계획

필수 신뢰성 및 계약 항목에 대한 구현 패스가 완료되었습니다.

완료됨:

- `process kill/remove` 대체 실제 종료
- 자식 어댑터 기본 종료 경로에 대한 프로세스 트리 취소
- 대체 종료 및 자식 어댑터 종료 경로에 대한 리그레션 테스트
- 명시적인 `ptyCommand` 아래에서 PTY 명령 에지 케이스 테스트
- 설계 상 `reconcileOrphans()`의 아무 작업도 하지 않는 명시적 메모리 내 재시작 경계

선택적 후속 작업:

- 행동 이동 없이 `runExecProcess`를 집중된 도우미로 분할

## 6. 파일 맵

### 프로세스 감독자

- 구별된 생성 입력 및 프로세스 로컬 표준 입력 계약으로 `src/process/supervisor/types.ts` 업데이트됨.
- 명시적인 `ptyCommand`를 사용하도록 `src/process/supervisor/supervisor.ts` 업데이트됨.
- `src/process/supervisor/adapters/child.ts` 및 `src/process/supervisor/adapters/pty.ts`는 에이전트 타입에서 분리됨.
- `src/process/supervisor/registry.ts`는 멱등 완료가 변경되지 않고 유지됨.

### Exec 및 프로세스 통합

- PTY 명령을 명시적으로 전달하고 대체 경로를 유지하도록 `src/agents/bash-tools.exec-runtime.ts` 업데이트됨.
- 실제 프로세스 트리 대체 종료로 감독자를 통해 취소하도록 `src/agents/bash-tools.process.ts` 업데이트됨.
- `src/agents/bash-tools.shared.ts`에서 직접 종료 도우미 경로 제거됨.

### CLI 신뢰성

- `src/agents/cli-watchdog-defaults.ts`를 공유 기본으로 추가함.
- `src/agents/cli-backends.ts` 및 `src/agents/cli-runner/reliability.ts`는 이제 동일한 기본값을 사용함.

## 7. 이번 실행에서의 유효성 검사 실행

단위 테스트:

- `pnpm vitest src/process/supervisor/registry.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.pty-command.test.ts`
- `pnpm vitest src/process/supervisor/adapters/child.test.ts`
- `pnpm vitest src/agents/cli-backends.test.ts`
- `pnpm vitest src/agents/bash-tools.exec.pty-cleanup.test.ts`
- `pnpm vitest src/agents/bash-tools.process.poll-timeout.test.ts`
- `pnpm vitest src/agents/bash-tools.process.supervisor.test.ts`
- `pnpm vitest src/process/exec.test.ts`

엔드투엔드 대상:

- `pnpm test:e2e src/agents/cli-runner.e2e.test.ts`
- `pnpm test:e2e src/agents/bash-tools.exec.pty-fallback.e2e.test.ts src/agents/bash-tools.exec.background-abort.e2e.test.ts src/agents/bash-tools.process.send-keys.e2e.test.ts`

타입체크 노트:

- `pnpm tsgo`는 현재 이 레포에서 사전 존재하는 UI 타입 종속성 문제로 실패하고 있으며, 이는 이 프로세스 감독 작업과 관련이 없습니다 (`@vitest/browser-playwright` 해결 문제).

## 8. 운영 보증 유지

- Exec 환경 강화 동작은 변경되지 않습니다.
- 승인 및 허용 목록 흐름은 변경되지 않습니다.
- 출력 정화 및 출력 용량은 변경되지 않습니다.
- PTY 어댑터는 여전히 강제 종료 및 리스너 폐기에 대한 대기 완료를 보장합니다.

## 9. 완료 정의

1. 감독자는 관리 실행의 라이프사이클 소유자입니다.
2. PTY 생성은 argv 재구성이 없는 명시적 명령 계약을 사용합니다.
3. 프로세스 계층은 감독자 표준 입력 계약에 대해 에이전트 계층에 타입 의존성이 없습니다.
4. 감시자 기본값은 단일 소스입니다.
5. 목표 단위 및 엔드투엔드 테스트는 여전히 초록색을 유지합니다.
6. 재시작 내구성 경계는 명시적으로 문서화되거나 완전히 구현됩니다.

## 10. 요약

이 브랜치는 이제 일관되며 더 안전한 감독 형상을 가집니다:

- 명시적 PTY 계약
- 더 깔끔한 프로세스 계층화
- 프로세스 작업을 위한 감독자 구동 취소 경로
- 감독자 조회 실패 시 실제 대체 종료
- 자식 실행 기본 종료 경로에 대한 프로세스 트리 취소
- 통합된 감시자 기본값
- 명시적인 메모리 내 재시작 경계 (이번 작업에서는 재시작 간 고아 조정 없음)