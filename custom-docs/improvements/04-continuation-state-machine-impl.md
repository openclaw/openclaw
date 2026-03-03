# #4 계속실행 상태머신 리팩토링 — 구현 진행 (Phase 1 완료)

> 시작일: 2026-02-19
> 설계 문서: `04-continuation-state-machine.md`

## Phase 1: 상태머신 코어 구현 — ✅ 완료

### 신규 파일: `src/infra/continuation-state-machine.ts` (~350 LOC)

**순수 함수 기반 결정 로직** — I/O 없음, 부작용 없음, 완전한 단위 테스트 가능.

#### 타입 정의

- `ContinuationActionType`: `CONTINUE | ESCALATE | BACKOFF | UNBLOCK | ABANDON | SKIP | COMPACT | BACKLOG_RECOVER`
- `ContinuationAction`: 액션 디스크립터 (type, reason, delayMs, escalationType 등)
- `AgentContinuationState`: 에이전트별 인메모리 상태 (backoff, failures)
- `SelfDrivingState`: 자기주도 루프 상태 (consecutive count, step tracking)
- `FailureReason`: `rate_limit | billing | timeout | context_overflow | unknown`
- `BackoffStrategy`: 실패 유형별 백오프 전략 맵

#### 순수 결정 함수

| 함수                             | 역할                   | 대응 기존 코드                          |
| -------------------------------- | ---------------------- | --------------------------------------- |
| `decidePollingAction()`          | 폴링 트리거 결정       | `task-continuation-runner.ts` 핵심 로직 |
| `decideSelfDrivingAction()`      | 자기주도 트리거 결정   | `task-self-driving.ts` 핵심 로직        |
| `decideStepContinuationAction()` | 스텝 완료 폴백 결정    | `task-step-continuation.ts` 핵심 로직   |
| `decideBackoffAction()`          | 실패 후 백오프 결정    | 분산된 백오프 로직 통합                 |
| `updateSelfDrivingProgress()`    | 자기주도 상태 업데이트 | `task-self-driving.ts` 상태 추적        |
| `calculateBackoffDelay()`        | 백오프 시간 계산       | `resolveBackoffMs()` 통합               |
| `parseFailureReason()`           | 에러 메시지 분류       | `parseFailureReason()` 통합             |
| `checkZombie()`                  | 좀비 태스크 감지       | `isZombie()` 통합                       |
| `decideZombieAction()`           | 좀비 처리 결정         | 좀비 복구/에스컬레이션 로직             |

#### 상수 통합

기존 3개 파일에 분산된 상수를 단일 모듈로 통합:

- `ZOMBIE_TASK_TTL_MS`, `CONTINUATION_COOLDOWN_MS`, `MAX_CONSECUTIVE_SELF_DRIVES`
- `MAX_STALLS_ON_SAME_STEP`, `MAX_ZERO_PROGRESS_RUNS`, `MAX_UNBLOCK_REQUESTS`
- `BACKOFF_STRATEGIES` 맵 (5가지 실패 유형별 전략)

### 신규 파일: `src/infra/continuation-state-machine.test.ts` (~525 LOC)

**56 단위 테스트** 전체 통과:

| 테스트 그룹                    | 수  | 커버리지                                                                              |
| ------------------------------ | --- | ------------------------------------------------------------------------------------- |
| `calculateBackoffDelay`        | 10  | 모든 실패 유형, 경계값, 제안 백오프, 최소값                                           |
| `parseFailureReason`           | 6   | rate_limit, billing, timeout, context_overflow, unknown                               |
| `checkZombie`                  | 4   | 24h 경계, fallback date, custom TTL                                                   |
| `decideZombieAction`           | 3   | BACKLOG_RECOVER, ABANDON, reassign limit                                              |
| `decidePollingAction`          | 11  | completed, pending_approval, busy, zombie, backoff, cooldown, idle, blocked, continue |
| `decideSelfDrivingAction`      | 8   | no task, no steps, all done, busy, max consecutive, stalled, zero progress, normal    |
| `decideStepContinuationAction` | 5   | self-driving grace, no task, all done, busy, normal                                   |
| `decideBackoffAction`          | 3   | rate_limit, consecutive failures, suggested backoff                                   |
| `updateSelfDrivingProgress`    | 6   | increment, stall tracking, step change, zero progress, cooldown reset                 |

## 남은 Phase (미착수)

### Phase 2: 실행 레이어 (`continuation-executor.ts`)

- `ContinuationExecutor` 클래스: 액션 디스크립터 → 실제 부작용 실행
- 태스크별 뮤텍스로 동시 실행 방지

### Phase 3: 어댑터 구현

- `LifecycleEndAdapter`, `StepCompletedAdapter`, `PollingAdapter`
- 각 트리거 소스가 결정 함수를 호출하도록 래핑

### Phase 4: 기존 파일 교체

- `task-continuation-runner.ts`: 1,407 → ~200 LOC
- `task-self-driving.ts`: 352 → ~80 LOC
- `task-step-continuation.ts`: 205 → ~60 LOC

### Phase 5: 검증 + 정리

- 전체 테스트 통과 확인
- 기존 동작과 동일한지 통합 테스트 검증

## 설계 문서 대비 차이점

1. **결정 함수 분리**: 설계 문서의 단일 `decideNextAction()` 대신, 트리거별로 분리된 결정 함수 (`decidePollingAction`, `decideSelfDrivingAction`, `decideStepContinuationAction`). 각 트리거가 필요로 하는 입력이 다르므로 분리가 더 자연스러움.
2. **BACKLOG_RECOVER 액션 추가**: 설계 문서에 없지만 기존 코드에 있는 좀비 태스크→backlog 복구 로직 반영.
3. **Phase 1만 완료**: 기존 파일 수정 없이 새 모듈만 추가 (안전한 시작). Phase 2-5는 후속 작업.
