# #9 조정 불변량 테스트 스위트 — 구현 기록

> 구현일: 2026-02-19
> 상태: 완료 (TC-01~07, 22 tests)

---

## 변경 파일

| 파일                                        | 변경 유형 | LOC  | 설명                             |
| ------------------------------------------- | --------- | ---- | -------------------------------- |
| `src/infra/coordination-invariants.test.ts` | 신규      | ~550 | TC-01~07 조정 불변량 테스트 22개 |

## 설계 문서와의 차이점

### 테스트 파일 경로

- **설계**: `src/infra/coordination-invariants.e2e.test.ts` (e2e 테스트)
- **구현**: `src/infra/coordination-invariants.test.ts` (단위 테스트)
- **이유**: TC-01~04는 실제 Gateway 프로세스 없이 파일 기반 모듈만 사용하므로 단위 테스트로 분류가 더 적합. E2E 설정(vmForks 풀, 별도 worker 수)의 오버헤드 불필요.

### 테스트 헬퍼 구조

- **설계**: 별도 파일 (`src/infra/test-helpers/coordination-fixture.ts`, `test-barrier.ts`, `test-event-bus.ts`)
- **구현**: 테스트 파일 내 인라인 헬퍼 (`createBarrier()`, `makeTask()`, `makeStep()`)
- **이유**: TC-01~04에 필요한 헬퍼가 ~30 LOC로 매우 작음. 별도 파일 분리는 Phase 3(TC-05~07) 추가 시 필요에 따라 진행.

### TC-02: 멱등성 → Block-Resume 라운드트립

- **설계**: 멱등성 키 기반 중복 처리 테스트
- **구현**: block→resume 상태 전이 라운드트립 테스트
- **이유**: 멱등성 키 인프라는 아직 미구현(#8 구조화된 핸드오프 페이로드에서 구현 예정). block→resume은 실제 프로덕션 코드에서 더 빈번하게 사용되는 패턴이며, 현재 전담 테스트가 없었음.

### TC-04: A2A 재시작 복구 → 세션 격리

- **설계**: Gateway 재시작 시뮬레이터 + A2A 플로우 복구 테스트
- **구현**: 에이전트 workspace 분리 + 독립 lock 테스트
- **이유**: A2A 재시작 복구는 #2(A2A 내구성) 미구현 상태에서 의미 있는 테스트 작성 불가. 세션 격리는 현재 multi-agent 아키텍처의 근본 불변량이며, 전담 테스트 부재.

### Vitest 설정

- **설계**: `vitest.coordination.config.ts` 전용 설정 + `test:coordination` 스크립트
- **구현**: 기존 `vitest.config.ts` 사용 (단위 테스트 분류)
- **이유**: 기존 단위 테스트 include 패턴 `src/**/*.test.ts`에 자연스럽게 포함됨. 별도 설정은 TC-05~07 추가 시 e2e 전용으로 분리 가능.

## 테스트 케이스 상세

### TC-01: 락 경합 (3 tests)

| 테스트                     | 불변량                                   | 방법                                                      |
| -------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| 10개 동시 lock → 1개 성공  | `acquireTaskLock()`의 `wx` 플래그 원자성 | `createBarrier(10)` + `Promise.allSettled()`              |
| lock release → 재획득 가능 | lock 해제 후 새 lock 획득 가능           | 순차 acquire→release→acquire                              |
| 동시 lock-release 사이클   | mutual exclusion                         | 5 workers × retry loop, `maxConcurrentHolders === 1` 검증 |

### TC-02: Block → Resume 라운드트립 (2 tests)

| 테스트                   | 불변량                                               | 방법                                     |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------- |
| 상태 전이 + 데이터 보존  | in_progress→blocked→in_progress, steps/progress 유지 | `writeTask()` + `readTask()` + 필드 검증 |
| 다중 block-resume 사이클 | 3회 반복 시 데이터 누적, 손상 없음                   | 3-cycle loop + progress 카운트 검증      |

### TC-03: 중복 Complete 방지 (4 tests)

| 테스트                        | 불변량                                      | 방법                                               |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------- |
| stop guard → 미완료 step 차단 | incomplete steps 시 `blocked: true`         | `checkStopGuard()` 직접 호출                       |
| stop guard → 완료/스킵 허용   | done+skipped 시 `blocked: false`            | `checkStopGuard()` 직접 호출                       |
| 동시 complete → 1개만 성공    | lock 경합으로 1개만 task.status='completed' | `createBarrier(5)` + lock + `Promise.allSettled()` |
| 전체 pending → 최대 차단      | 5개 pending step 시 모두 보고               | `checkStopGuard()` + count 검증                    |

### TC-04: 세션 격리 (3 tests)

| 테스트         | 불변량                                      | 방법                                                                |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| workspace 격리 | 각 agent는 자신의 tasks만 접근 가능         | 별도 tmpdir + `listTasks()`/`findActiveTask()`/`findBlockedTasks()` |
| lock 독립성    | agent A의 lock이 agent B에 영향 없음        | 동일 taskId, 다른 workspace → 둘 다 성공                            |
| 동시 쓰기 격리 | 10+10 동시 쓰기 시 cross-contamination 없음 | `createBarrier(20)` + `listTasks()` 교차 검증                       |

## 실행 방법

```bash
# 단독 실행
pnpm vitest run src/infra/coordination-invariants.test.ts

# 전체 단위 테스트에 포함 (기존 패턴 `src/**/*.test.ts`)
pnpm test
```

## 성능

- **22 tests**: ~387ms (transform 포함 전체 583ms)
- **설계 목표**: 60초 이내 → **달성** (0.39초)

## Phase 3: 고급 불변량 테스트 (TC-05~07) — 완료

### 추가 import

```typescript
import {
  type TaskDelegation,
  type DelegationEvent,
  type DelegationSummary,
} from "../agents/tools/task-delegation-types.js";
import { A2AJobManager, STALE_JOB_THRESHOLD_MS } from "../agents/tools/a2a-job-manager.js";
import { A2AJobReaper } from "../agents/tools/a2a-job-reaper.js";
import {
  A2AConcurrencyGateImpl,
  A2AConcurrencyError,
  type A2AConcurrencyConfig,
} from "../agents/a2a-concurrency.js";
```

### TC-05: Task Persistence Across Restart (3 tests)

| 테스트              | 불변량                                 | 방법                                                    |
| ------------------- | -------------------------------------- | ------------------------------------------------------- |
| steps/progress 보존 | write→re-read 시 모든 필드 유지        | `writeTask()` → `readTask()` 라운드트립                 |
| delegation 보존     | delegation/events/summary 라운드트립   | TaskFile + delegations 직렬화/파싱 검증                 |
| 다중 task + listing | 5개 다른 상태의 task, 리스팅/쿼리 정상 | `listTasks()`, `findActiveTask()`, `findBlockedTasks()` |

### TC-06: A2A Job Durability & Recovery (3 tests)

| 테스트                                       | 불변량                                | 방법                                            |
| -------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| manager 재인스턴스화 생존                    | job 파일이 디스크 기반으로 영속됨     | manager1 write → manager2 read                  |
| reaper 복구: stale→ABANDONED, recent→PENDING | 재시작 시 stale 잡 폐기, 최근 잡 복구 | `updatedAt` 백데이트 + `runOnStartup()`         |
| resumable jobs 필터링                        | reaper 후 PENDING만 반환              | `getResumableJobs()` — ABANDONED/COMPLETED 제외 |

### TC-07: A2A Concurrency Gate (4 tests)

| 테스트                         | 불변량                              | 방법                                                |
| ------------------------------ | ----------------------------------- | --------------------------------------------------- |
| maxConcurrentFlows 준수 + 큐잉 | limit 초과 시 대기, release 시 진행 | `acquire()` 3회 (limit=2) → 1개 큐 → release → 진행 |
| 5개 동시 acquire (limit=2)     | 2개 즉시, 3개 큐, 전부 완료         | `Promise.all()` + 순차 release                      |
| 타임아웃 → A2AConcurrencyError | 큐 대기 초과 시 에러                | `queueTimeoutMs=100` + 점유 중 acquire              |
| 에이전트 독립성                | agent-a와 agent-b의 제한 독립       | 각각 limit=1 → 둘 다 성공                           |

## 후속 작업

- 모든 TC 완료. 추가 파라미터화 테스트 (에이전트 수 × 동시 작업 수) 필요 시 확장 가능.
- 필요 시 `vitest.coordination.config.ts` 별도 설정 생성
