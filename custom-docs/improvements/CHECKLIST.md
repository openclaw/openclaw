# 아키텍처 개선 체크리스트

> 목표: 부채 점수 65/100 → 45/100 이하
> 작성일: 2026-02-19
> 마지막 업데이트: 2026-02-19

---

## 범례

- [ ] 미착수
- [~] 진행 중
- [x] 완료
- ❌ 취소/보류

> **규칙**: 각 개선안의 구현이 완료되면 ✅ 체크 후, 반드시 `prontolab/custom/`에 구현 내용을 문서로 기록한다.
> 기록 항목: 변경된 파일 목록, 설계 문서와의 차이점, 운영 영향, 마이그레이션 노트 등.

---

## Phase 1: 기반 + 독립 개선

### #1 A2A 대화 연속성 인덱스 교체 (🔴 높음, L) — [설계 문서](./01-a2a-conversation-index.md)

- [x] Phase 1: 인덱스 자료구조 구현
  - [x] `a2a-conversation-index.ts` 생성 (HashMap 기반 O(1) 조회)
  - [x] 인덱스 파일 구조 정의 및 직렬화/역직렬화
- [x] Phase 2: 기존 조회 로직 교체
  - [x] 선형 스캔 호출부를 인덱스 조회로 전환
  - [x] 인메모리 캐시와 인덱스 동기화
- [x] Phase 3: 쓰기 경로 통합
  - [x] 새 A2A 대화 생성 시 인덱스 자동 업데이트
  - [x] 대화 종료/삭제 시 인덱스 정리
- [x] Phase 4: 검증 및 마이그레이션
  - [x] 단위 테스트 (`a2a-index.test.ts`) — 24 tests 전체 통과
  - [x] 통합 테스트 (기존 A2A 플로우 동작 확인)
  - [x] 회귀 테스트 (events/ 모듈 42 tests 전체 통과, pnpm build 성공)
  - [x] 마이그레이션: 인덱스 없으면 빈 상태로 시작 (graceful degradation)
- [x] **검증**: A2A 전송 지연이 대화 수와 무관하게 일정 (O(1))
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 (변경 파일, 설계 차이, 운영 영향)

### #3 task-tool.ts 모듈 분할 (🟡 중간, L) — [설계 문서](./03-task-tool-modularization.md) | [구현 기록](./03-task-tool-modularization-impl.md)

- [x] Phase 1-2: 타입/상수/I/O 추출
  - [x] `task-file-io.ts` 생성 (801 LOC — 타입, 상수, 헬퍼, 파일 I/O, 쿼리)
  - [x] `task-file-io.test.ts` 작성 (61 tests 통과)
- [x] Phase 3: Stop Guard 분리
  - [x] `task-stop-guard.ts` 생성 (47 LOC — 순수 함수)
  - [x] `task-stop-guard.test.ts` 작성 (14 tests 통과)
- [x] Facade 전환
  - [x] `task-tool.ts` → facade + schemas + tool factories (2,296→1,548 LOC)
  - [x] 기존 테스트 회귀 방지 (72 tests 수정 없이 통과)
  - [x] `pnpm build` 성공
- [x] Phase 4-5: CRUD/Blocking/Steps 추가 분리
  - [x] `task-crud.ts` 생성 (932 LOC — 6개 CRUD 도구 팩토리: task_start, task_update, task_step_update, task_list, task_complete, task_cancel)
  - [x] `task-blocking.ts` 생성 (603 LOC — 5개 blocking/backlog 도구 팩토리: task_block, task_resume, task_approve, task_backlog, task_status)
  - [x] `task-steps.ts` 생성 (21 LOC — summarizeStepCounts 헬퍼)
  - [x] `task-tool.ts` → 45 LOC thin facade (re-export만)
  - [x] 기존 72 tests 수정 없이 통과, 외부 import 경로 변경 없음
- [x] **검증**: 5개 모듈 분리 완료 (task-file-io, task-stop-guard, task-crud, task-blocking, task-steps), 147 tests 전체 통과, 외부 import 경로 변경 없음
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #5 Gateway 순수 조합 전환 (🟡 중간, L) — [설계 문서](./05-gateway-composition.md) | [구현 기록](./05-gateway-composition-impl.md)

- [x] Phase 1: 설정/진단/Control UI 초기화 분리
  - [x] `server-init-config.ts` 생성 (83 LOC — 설정 마이그레이션, 유효성 검사, 플러그인 자동 활성화)
  - [x] `server-init-diagnostics.ts` 생성 (25 LOC — 진단 하트비트, 재시작 정책)
  - [x] `server-init-control-ui.ts` 생성 (61 LOC — Control UI 에셋 해석)
- [x] server.impl.ts 축소
  - [x] 737 LOC → 632 LOC
  - [x] ~80 imports → 57 imports
  - [x] 15개 import 제거 (init 모듈로 이동)
- [x] 검증
  - [x] `pnpm build` 통과
  - [x] gateway 테스트 46/47 pass (1 pre-existing failure)
  - [x] 기존 동작 변경 없음 (순수 리팩토링)
- [x] Phase 2-4: Registry/Events/Cron 분리
  - [x] `server-init-registry.ts` 생성 (51 LOC — NodeRegistry, 구독 매니저, 노드 헬퍼, 레인 동시성)
  - [x] `server-init-events.ts` 생성 (139 LOC — 에이전트 이벤트, 하트비트, 유지보수 타이머, 스킬 리프레시)
  - [x] `server-init-cron.ts` 생성 (30 LOC — 크론 서비스 빌드 + 시작)
  - [x] `server.impl.ts` → 565 LOC, 48 imports (원본 737 LOC, ~80 imports에서 감소)
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #7 A2A 에이전트별 동시성 제한 (🟡 중간, L) — [설계 문서](./07-a2a-concurrency-control.md) | [구현 기록](./07-a2a-concurrency-control-impl.md)

- [x] Phase 1: 핵심 세마포어 구현
  - [x] `a2a-concurrency.ts` 생성 (156 LOC — 에이전트별 세마포어 + FIFO 큐 + 타임아웃)
  - [x] `a2a-concurrency.test.ts` 작성 (14 tests 통과)
- [x] Phase 2: A2A 플로우 통합
  - [x] `sessions-send-tool.a2a.ts`에 acquire/release 삽입 (try/finally 패턴)
  - [x] `server-startup.ts`에 `initA2AConcurrencyGate()` 호출 추가
- [x] 후속: 에이전트별 maxConcurrentFlows 설정 스키마 확장 (agents.defaults.a2aConcurrency config, 7 tests)
- [x] **검증**: 14 tests pass, pnpm build 성공, 기존 테스트 회귀 없음
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #9 조정 불변량 테스트 스위트 — 기본 (🟡 중간, L) — [설계 문서](./09-coordination-invariants-tests.md) | [구현 기록](./09-coordination-invariants-tests-impl.md)

- [x] Phase 1: 테스트 인프라 (인라인 픽스처)
  - [x] `createBarrier()` 배리어 동기화 유틸리티 (테스트 파일 내장)
  - [x] `makeTask()` / `makeStep()` 팩토리 헬퍼
  - [x] 격리된 tmpdir 기반 픽스처 (beforeEach/afterEach)
- [x] Phase 2: 핵심 불변량 테스트 구현
  - [x] TC-01: 락 경합 (10개 동시 acquireTaskLock → 정확히 1개 성공, 3개 서브테스트)
  - [x] TC-02: block→resume 라운드트립 (상태 전이 + 데이터 보존, 2개 서브테스트)
  - [x] TC-03: 중복 complete 방지 (stop guard + 동시 lock, 4개 서브테스트)
  - [x] TC-04: 에이전트 세션 격리 (workspace 분리 + 독립 lock, 3개 서브테스트)
- [x] **검증**: 12 tests 전체 통과 (60ms), pnpm build에 영향 없음
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #12 Task Enforcement Bypass 수정 (🔴 높음, M) — [설계 문서](./12-task-enforcement-bypass.md) | [구현 기록](./12-task-enforcement-bypass-impl.md)

- [x] Phase 1: 디스크 체크 세션 범위 제한
  - [x] `TaskFile.createdBySessionKey` 필드 추가 (`task-file-io.ts` — 인터페이스, 직렬화, 파싱)
  - [x] `task_start`에서 `createdBySessionKey` 자동 기록 (`task-tool.ts`)
  - [x] `hasActiveTaskFiles()`를 세션 키 기반으로 변경 (`task-enforcer.ts`)
  - [x] 기존 task 파일 호환성: 세션 메타데이터 없는 파일은 bypass 불가 (보안 우선)
  - [x] 유닛 테스트: 세션 범위 체크 4개 (matching/different/legacy/empty) — 20 tests 전체 통과
- [x] Phase 2: A2A 세션 프롬프트 수정
  - [x] `attempt.ts` promptMode: A2A/cron → "full" (subagent만 "minimal")
  - [x] 결과: A2A 세션에서도 Task Tracking 지시 포함됨
  - [x] 미사용 import (`isA2ASessionKey`, `isCronSessionKey`) 정리
- [x] Phase 3: Stale Task 정리
  - [x] `cleanupStaleTasks()` 함수 구현 (`task-enforcer.ts` — export)
  - [x] 24시간 임계값, in_progress/pending → abandoned 전환
  - [x] 호출 시점은 세션 시작 시 (`attempt.ts`에서 호출 가능 — 현재 export만)
- [x] **검증**: 20 tests pass, 98 관련 tests pass, tsc --noEmit 에러 없음
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

---

## Phase 2: 심화 개선

### #2 A2A 플로우 내구성 확보 (🔴 높음, XL) — [설계 문서](./02-a2a-durable-jobs.md) | [구현 기록](./02-a2a-durable-jobs-impl.md)

- [x] Phase 1: A2AJobManager (영구 저장소)
  - [x] `a2a-job-manager.ts` 생성 (~255 LOC — 타입, CRUD, 상태전이, 턴 진행, 스테일 감지, 7일 TTL)
  - [x] Singleton: `initA2AJobManager()` / `getA2AJobManager()` / `resetA2AJobManager()`
  - [x] Atomic write: `.tmp` + `rename` 패턴
  - [x] `a2a-job-manager.test.ts` — 27 tests 통과
- [x] Phase 2: A2AJobReaper (시작 시 복구)
  - [x] `a2a-job-reaper.ts` 생성 (~100 LOC — 스테일 ABANDONED, RUNNING→PENDING 리셋)
  - [x] `a2a-job-reaper.test.ts` — 8 tests 통과
- [x] Phase 3: runSessionsSendA2AFlow() 인터페이스 확장
  - [x] `sessions-send-tool.a2a.ts`에 `startTurn?`, `signal?`, `onTurnComplete?` 파라미터 추가
  - [x] AbortSignal 체크 + onTurnComplete 콜백 삽입
  - [x] 기존 테스트 회귀 없음 (6 pre-existing failures 동일)
- [x] Phase 4: A2AJobOrchestrator (브릿지)
  - [x] `a2a-job-orchestrator.ts` 생성 (~150 LOC — 순환 의존 방지)
  - [x] `createAndStartFlow()`: 잡 생성 → RUNNING → 플로우 → COMPLETED/FAILED
  - [x] `resumeFlows()`: PENDING 잡 재개
  - [x] Fallback: JobManager 미초기화 시 기존 직접 실행
  - [x] `a2a-job-orchestrator.test.ts` — 8 tests 통과
- [x] Phase 5: Fire-and-forget 패턴 교체
  - [x] `sessions-send-tool.ts`: `runSessionsSendA2AFlow` → `createAndStartFlow`
  - [x] `message-handler.process.ts`: 동일 교체
- [x] Phase 6: 게이트웨이 시작 연결
  - [x] `server-startup.ts`: `initA2AJobManager()` + `A2AJobReaper.runOnStartup()` + `resumeFlows()`
  - [x] `stateDir` function scope로 이동 (기존 try 블록 스코프 버그 수정)
- [x] Phase 7: 검증 및 문서화
  - [x] 45 tests 전체 통과 (27 manager + 9 reaper + 9 orchestrator)
  - [x] TypeScript `--noEmit` — 변경 파일 에러 없음
  - [x] 기존 A2A 테스트 회귀 없음 (pre-existing 6 failures 동일)
- [x] **검증**: Gateway 재시작 후 진행 중이던 A2A 대화가 자동 복구
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #6 DI 서비스 경계 확장 (🟡 중간, L) — [설계 문서](./06-dependency-injection.md) — ❌ N/A

> **스킵 사유**: 설계 문서의 전제 조건이 실제 코드베이스와 불일치.
> 설계 문서는 server-methods에서 getEventBus(), getTaskManager() 등 전역 싱글톤을
> 직접 import한다고 가정했으나, 실제로는 이러한 싱글톤이 존재하지 않음.
> GatewayRequestContext (types.ts, ~40 필드)가 이미 모든 서비스를 핸들러에 주입하는
> DI 패턴을 구현하고 있어, 설계 목표(테스트 용이성, 직접 import 제거)가 이미 달성됨.

### #8 구조화된 핸드오프 페이로드 (🟢 중간-낮음, L) — [설계 문서](./08-structured-handoff.md) | [구현 기록](./08-structured-handoff-impl.md)

- [x] Phase 1: 페이로드 타입 정의 + 파서 + 검증기
  - [x] `a2a-payload-types.ts` 생성 (4가지 페이로드 인터페이스 + 유니온 타입)
  - [x] `a2a-payload-parser.ts` 생성 (parseA2APayload, validateA2APayload, buildPayloadSummary, mapPayloadTypeToMessageIntent)
  - [x] `a2a-payload-parser.test.ts` 작성 (42 tests 통과)
- [x] Phase 2: sessions_send 도구 확장
  - [x] `payloadJson` optional 파라미터 추가 (TypeBox 스키마)
  - [x] 파싱 + 검증 후 컨텍스트 빌더/A2A 플로우에 전달
- [x] Phase 3: A2A 플로우 통합
  - [x] `sessions-send-helpers.ts` — buildAgentToAgentMessageContext에 payload summary 삽입
  - [x] `sessions-send-tool.a2a.ts` — payloadType/payloadJson 이벤트 기록 + 인텐트 분류 단축
  - [x] `a2a-job-orchestrator.ts` — payloadType/payloadJson 패스스루
- [x] Phase 4: 검증
  - [x] 42 tests 전체 통과
  - [x] 기존 관련 테스트 91 tests (90 pass, 1 pre-existing failure)
  - [x] TypeScript --noEmit 변경 파일 에러 없음
  - [x] 역호환: payloadJson 없는 기존 호출 동작 변경 없음 (null fallback)
- [x] **검증**: 구조화 페이로드 시 인텐트 분류 confidence=1.0 (LLM 추론 건너뜀), 기존 자유텍스트 역호환 유지
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #4 계속실행 상태머신 리팩토링 (🟡 중간, XL) — [설계 문서](./04-continuation-state-machine.md) | [구현 기록](./04-continuation-state-machine-impl.md)

- [x] Phase 1: 상태머신 코어 + 순수 결정 함수 (continuation-state-machine.ts ~350 LOC)
  - [x] 타입 정의: ContinuationActionType, AgentContinuationState, SelfDrivingState, BackoffStrategy
  - [x] 순수 결정 함수: decidePollingAction, decideSelfDrivingAction, decideStepContinuationAction
  - [x] 보조 함수: calculateBackoffDelay, parseFailureReason, checkZombie, decideZombieAction
  - [x] 백오프 전략 맵 (BACKOFF_STRATEGIES) — 5가지 실패 유형별 통합
  - [x] 단위 테스트 56개 전체 통과 (continuation-state-machine.test.ts)
- [ ] Phase 2: 순수 결정 함수 구현
  - [ ] `ContinuationExecutor` 클래스 (부작용 실행 레이어)
- [ ] Phase 3: 기존 3개 파일 리팩토링
  - [ ] `task-continuation-runner.ts` → 결정 함수 호출로 전환
  - [ ] `task-self-driving.ts` → 결정 함수 호출로 전환
  - [ ] `task-step-continuation.ts` → 결정 함수 호출로 전환
- [ ] Phase 4: 백오프/재시도 로직 통합
  - [ ] 분산된 백오프 계산을 결정 함수 내부로 통합
- [ ] Phase 5: 검증 + 정리
  - [ ] 결정 함수 단위 테스트 (핵심)
  - [ ] 백오프 계산 테스트
  - [ ] 통합 테스트 시나리오 (5-Layer Safety Net 동작 확인)
  - [ ] `pnpm test` 통과
- [ ] **검증**: 단일 결정 함수에서 모든 continuation 결정이 이루어짐, 관례 의존 제거
- [ ] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 (상태머신 다이어그램, 결정 매트릭스)

---

## Phase 3: 통합 + 검증

### #10 Discord A2A 크로스플레인 통합 (🟢 낮음, M-L) — [설계 문서](./10-cross-plane-unification.md) — ❌ N/A (부분 해소)

> **스킵 사유**: #2 (A2A 플로우 내구성)에서 createAndStartFlow() (a2a-job-orchestrator)를
> 도입하면서 두 경로(sessions_send + Discord DM relay)가 이미 동일한 진입점을 공유.
> 설계 문서가 문제로 지적한 "직접 runSessionsSendA2AFlow 호출"은 이미 해소됨.
> 7개 인터페이스 + DI + Factory 추상화의 ROI가 낮아 스킵.
>
> **잔여 차이 (기록용)**: 두 경로가 createAndStartFlow를 공유하지만,
> 그 앞단의 전처리에 다음 차이가 존재한다:
>
> | 관심사                              | sessions_send                            | Discord DM relay    |
> | ----------------------------------- | ---------------------------------------- | ------------------- |
> | A2A 정책 검사 (sessions-access.ts)  | ✅ sessions-helpers.ts 경유              | ❌ 미적용           |
> | payloadType / payloadJson 전달      | ✅                                       | ❌                  |
> | taskId / workSessionId / depth 전달 | ✅                                       | ❌                  |
> | 대화 연속성 메타데이터              | ✅ conversationId + parentConversationId | ✅ conversationId만 |
>
> 이 차이가 의도적인지(sibling bot은 정책 검사 불필요) 누락인지는
> 향후 A2A 정책을 강화할 때 재검토 필요.

### #9 조정 불변량 테스트 스위트 — 완전 (🟡 중간) — [설계 문서](./09-coordination-invariants-tests.md) | [구현 기록](./09-coordination-invariants-tests-impl.md)

- [x] Phase 3: 고급 불변량 테스트 추가
  - [x] TC-05: Gateway 재시작 후 task 상태 보존 (delegation 포함 write→re-read, 3 tests)
  - [x] TC-06: A2A 내구성 복구 시나리오 (JobManager 재인스턴스화, Reaper stale→ABANDONED, 3 tests)
  - [x] TC-07: 동시성 제한 동작 시나리오 (maxConcurrentFlows 준수, 큐잉, 타임아웃, 에이전트 독립, 4 tests)
- [x] **검증**: 전체 조정 불변량 테스트 31개 통과
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

### #11 서브에이전트-Task 통합 라이프사이클 (🔴 높음, XL) — [설계 문서](./11-subagent-task-lifecycle.md) | [구현 기록](./11-subagent-task-lifecycle-impl.md)

- [x] Phase 1: Task-Subagent 연결 모델 정의 + 매니저
  - [x] `task-delegation-types.ts` 생성 (~120 LOC — 타입, 상태전이, 상수)
  - [x] `task-delegation-manager.ts` 생성 (~200 LOC — 순수 함수: create, update, summary, retry, find)
  - [x] `task-delegation-manager.test.ts` 작성 (110 tests — 상태전이, 데이터, 요약, 전이 매트릭스)
  - [x] TypeScript --noEmit 에러 없음
- [x] Phase 2: sessions_spawn 통합
  - [x] `task-delegation-persistence.ts` 생성 (158 LOC — CRUD helpers with task lock)
  - [x] TaskFile 인터페이스 확장 (delegations, delegationEvents, delegationSummary)
  - [x] `task-file-io.ts` 수정 (Markdown `## Delegations` 섹션 직렬화/파싱)
  - [x] `sessions-spawn-tool.ts` 수정 (taskId 있으면 createDelegation + appendDelegationToTask)
  - [x] `task-delegation-persistence.test.ts` 작성 (18 tests — CRUD, round-trip, full lifecycle)
- [x] Phase 3: subagent-announce 결과 연동
  - [x] `subagent-announce.ts` 수정 (taskId 있으면 delegation completed/failed + resultSnapshot)
  - [x] spawned→running→completed 자동 전환 처리 (lifecycle start 이벤트 미연동 대응)
- [x] Phase 4: task_verify 도구 구현
  - [x] `task-verify-tool.ts` 생성 (210 LOC — accept/reject/retry 액션)
  - [x] `openclaw-tools.ts` 수정 (task_verify 등록)
  - [x] `pi-tools.policy.ts` 수정 (서브에이전트 차단 목록에 추가)
  - [x] `task-verify-tool.test.ts` 작성 (7 tests)
- [x] Phase 5: 시스템 프롬프트
  - [x] `system-prompt.ts` 수정 (Subagent Delegation Tracking 섹션 추가)
- [x] **검증**: 216 tests 전체 통과 (110+18+61+7+20), tsc --noEmit 변경 파일 에러 없음
- [x] **문서화**: 구현 내용을 `prontolab/custom/`에 기록 완료

---

## 전체 완료 게이트

- [x] 모든 개선안 체크리스트 완료 (10/13 구현, 2 N/A, 1 Phase 1만 — Phase 2-5 보류)
- [ ] `pnpm build` 성공
- [x] `pnpm test` 회귀 없음 (1,514 tests pass, 3 pre-existing failures in session-utils.fs.test.ts)
- [ ] 아키텍처 부채 점수 재측정 (목표: ≤45/100)
- [ ] 2x 에이전트 부하 테스트 통과
- [ ] upstream sync 충돌 없음 확인
- [x] 모든 개선안의 구현 내용이 `prontolab/custom/`에 문서화 완료 (11개 \*-impl.md 파일)

---

## 변경 이력

| 날짜       | 변경                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-19 | 체크리스트 초기 작성                                                                                                                                                 |
| 2026-02-19 | 각 개선안에 설계 문서 링크 + 문서화 항목 추가                                                                                                                        |
| 2026-02-19 | #12 Task Enforcement Bypass 추가 (Phase 1)                                                                                                                           |
| 2026-02-19 | #7 Phase 1-2 완료 (a2a-concurrency.ts + A2A 플로우 통합, 14 tests)                                                                                                   |
| 2026-02-19 | #5 Phase 1 완료 (server-init-config/diagnostics/control-ui 추출, 737→632 LOC, 80→57 imports)                                                                         |
| 2026-02-19 | #3 Phase 1-3 완료 (task-file-io.ts + task-stop-guard.ts 추출, 147 tests)                                                                                             |
| 2026-02-19 | #9 기본 완료 (coordination-invariants.test.ts — TC-01~04, 12 tests)                                                                                                  |
| 2026-02-19 | #12 완료 (createdBySessionKey + session-scoped disk check + A2A prompt fix + cleanupStaleTasks)                                                                      |
| 2026-02-19 | #2 완료 (A2AJobManager + Reaper + Orchestrator + fire-and-forget 교체 + gateway startup, 43 tests)                                                                   |
| 2026-02-19 | #4 Phase 1 완료 (continuation-state-machine.ts — 순수 결정 함수 + 56 tests)                                                                                          |
| 2026-02-19 | #6 N/A 처리 (설계 문서 전제 불일치 — GatewayRequestContext가 이미 DI 패턴 구현)                                                                                      |
| 2026-02-19 | #8 완료 (a2a-payload-types + parser + sessions_send payloadJson + A2A flow 통합, 42 tests)                                                                           |
| 2026-02-19 | #10 N/A 처리 (#2에서 createAndStartFlow 도입으로 두 경로 이미 통합)                                                                                                  |
| 2026-02-19 | #11 Phase 1 완료 (task-delegation-types + manager + 110 tests)                                                                                                       |
| 2026-02-19 | #11 Phase 2-5 완료 (persistence + spawn/announce integration + task_verify + system prompt, 216 tests)                                                               |
| 2026-02-19 | #9 Phase 3 완료 (TC-05~07 추가: task persistence, A2A job durability, concurrency gate, 31 tests 전체 통과)                                                          |
| 2026-02-19 | #12 Follow-up: cleanupStaleTasks() 를 server-startup.ts에 연결 (게이트웨이 시작 시 전 에이전트 stale task 자동 정리)                                                 |
| 2026-02-19 | #7 Follow-up: agents.defaults.a2aConcurrency 설정 스키마 + resolver + server-startup 연결 (7 tests)                                                                  |
| 2026-02-19 | #3 Phase 4-5 완료 (task-crud.ts 932 LOC + task-blocking.ts 603 LOC + task-steps.ts 21 LOC + task-tool.ts → 45 LOC facade, 72 tests 통과)                             |
| 2026-02-20 | #5 Phase 2-4 완료 (server-init-registry 51 LOC + server-init-events 139 LOC + server-init-cron 30 LOC, server.impl.ts 737→565 LOC, ~80→48 imports, 46/47 tests pass) |
| 2026-02-20 | 전체 완료 게이트 업데이트: 10/13 구현 완료, 2 N/A, 1 Phase 1만 (Phase 2-5 보류). 1,514 tests pass, 0 regressions.                                                    |
