# #3 task-tool.ts 모듈 분할 — 구현 기록

> **구현일**: 2026-02-19
> **상태**: ✅ 전체 완료 (5개 모듈 분리 + 45 LOC facade)
> **설계 문서**: [03-task-tool-modularization.md](./03-task-tool-modularization.md)

---

## 1. 구현 요약

설계 문서의 Phase 1-5를 실행하여 `task-tool.ts` (2,296 LOC)를 5개의 독립 모듈 + thin facade로 분할했다.

### 추출된 모듈

| 모듈                 | LOC | 책임                                                                                                    |
| -------------------- | --- | ------------------------------------------------------------------------------------------------------- |
| `task-file-io.ts`    | 801 | 타입 정의, 상수, 헬퍼, 파일 I/O, 쿼리 함수                                                              |
| `task-stop-guard.ts` | 47  | Stop Guard 순수 함수 (미완료 스텝 검증)                                                                 |
| `task-crud.ts`       | 932 | 6개 CRUD 도구 팩토리 (task_start, task_update, task_step_update, task_list, task_complete, task_cancel) |
| `task-blocking.ts`   | 603 | 5개 blocking/backlog 도구 팩토리 (task_block, task_resume, task_approve, task_backlog, task_status)     |
| `task-steps.ts`      | 21  | summarizeStepCounts 헬퍼                                                                                |

### 변경된 `task-tool.ts`

| 항목 | 변경 전 | 변경 후                   |
| ---- | ------- | ------------------------- |
| LOC  | 2,296   | 45                        |
| 역할 | 모든 것 | Thin facade (re-export만) |

## 2. 변경된 파일 목록

### 신규 생성

- `src/agents/tools/task-file-io.ts` — 타입, 상수, 헬퍼, 파일 I/O, 쿼리 함수
- `src/agents/tools/task-file-io.test.ts` — 61개 단위 테스트 (순수 함수 검증)
- `src/agents/tools/task-stop-guard.ts` — `checkStopGuard()`, `formatStopGuardError()` 순수 함수
- `src/agents/tools/task-stop-guard.test.ts` — 14개 단위 테스트

### 수정

- `src/agents/tools/task-tool.ts` — Facade 패턴으로 재구성
  - `task-file-io.ts`에서 타입/함수 import
  - `task-stop-guard.ts`에서 `checkStopGuard()` import
  - 공개 API를 re-export하여 기존 import 경로 유지

## 3. 설계 문서와의 차이

### 계획 vs 실제

| 설계 문서 계획                                             | 실제 구현                      | 이유                                  |
| ---------------------------------------------------------- | ------------------------------ | ------------------------------------- |
| 5개 모듈 분리 (file-io, stop-guard, crud, steps, blocking) | 5개 모듈 분리 완료 ✅          | 설계 문서 목표 달성                   |
| `task-tool.ts` → ~50 LOC facade                            | `task-tool.ts` → 45 LOC facade | 설계 목표 달성 (re-export만)          |
| `task-file-io.ts` ~250 LOC                                 | 801 LOC                        | 타입 + I/O + 쿼리가 예상보다 큼       |
| `task-types.ts` 별도 파일                                  | `task-file-io.ts`에 타입 포함  | 별도 파일로 분리할 만큼 크지 않음     |
| `task-crud.ts` ~500 LOC 예상                               | 932 LOC                        | TypeBox 스키마 + 6개 팩토리 함수 포함 |
| `task-blocking.ts` ~300 LOC 예상                           | 603 LOC                        | TypeBox 스키마 + 5개 팩토리 함수 포함 |

### 후속 작업 — 완료 ✅

- [x] `task-crud.ts` 분리 (6개 CRUD 도구 팩토리)
- [x] `task-steps.ts` 분리 (summarizeStepCounts 헬퍼)
- [x] `task-blocking.ts` 분리 (5개 blocking/backlog 도구 팩토리)
- [x] `task-tool.ts` → 45 LOC thin facade (re-export만)

## 4. 모듈 구조

```
src/agents/tools/
├── task-tool.ts              (45 LOC, thin facade — re-export만)
├── task-tool.test.ts         (72 tests, 기존 — 변경 없이 통과)
├── task-crud.ts              (932 LOC, CRUD 도구)
│   ├── TypeBox schemas (task_start, task_update, task_step_update, task_list, task_complete, task_cancel)
│   └── createTask*Tool factory functions (6개)
├── task-blocking.ts          (603 LOC, blocking/backlog 도구)
│   ├── TypeBox schemas (task_block, task_resume, task_approve, task_backlog, task_status)
│   └── createTask*Tool factory functions (5개)
├── task-steps.ts             (21 LOC, 헬퍼)
│   └── summarizeStepCounts(task) → string
├── task-file-io.ts           (801 LOC, 타입 + I/O)
│   ├── All type exports (TaskStatus, TaskFile, TaskStep, etc.)
│   ├── Constants (TASKS_DIR, etc.)
│   ├── Helpers (generateTaskId, formatTaskFileMd, parseTaskFileMd, etc.)
│   ├── File I/O (readTask, writeTask, deleteTask, listTasks, etc.)
│   ├── Queries (findActiveTask, findPendingTasks, etc.)
│   └── History + pointer functions
├── task-file-io.test.ts      (61 tests, 신규)
├── task-stop-guard.ts        (47 LOC, 순수 함수)
│   ├── StopGuardResult interface
│   ├── checkStopGuard(task) → blocked/reason/incompleteSteps
│   └── formatStopGuardError(result) → string
└── task-stop-guard.test.ts   (14 tests, 신규)
```

## 5. 외부 의존성 영향

Facade 패턴으로 기존 import 경로가 모두 유지된다. 아래 파일들은 변경 불필요:

- `src/infra/task-step-continuation.ts`
- `src/infra/task-self-driving.ts`
- `src/infra/task-continuation-runner.ts`
- `src/discord/monitor/task-approvals.ts`
- `src/plugins/runtime/index.ts`
- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/subagent-spawn.ts`
- `src/agents/openclaw-tools.ts`
- `src/gateway/server-methods/agents.ts`

## 6. 테스트 결과

| 테스트 파일               | 테스트 수 | 상태                           |
| ------------------------- | --------- | ------------------------------ |
| `task-tool.test.ts`       | 72        | ✅ 전체 통과 (기존, 수정 없이) |
| `task-file-io.test.ts`    | 61        | ✅ 전체 통과 (신규)            |
| `task-stop-guard.test.ts` | 14        | ✅ 전체 통과 (신규)            |
| **합계**                  | **147**   | ✅                             |

- `pnpm build`: ✅ 성공
- 기존 테스트 회귀: 없음

## 7. 운영 영향

- **런타임 동작 변경**: 없음 (순수 리팩토링)
- **마이그레이션**: 불필요 (기존 task 파일 형식 동일)
- **설정 변경**: 없음
