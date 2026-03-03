# #2 A2A 플로우 내구성 확보 — 구현 완료

> 완료일: 2026-02-19
> 설계 문서: `02-a2a-durable-jobs.md`

## 구현 요약

A2A(Agent-to-Agent) 플로우의 fire-and-forget 패턴을 **파일 기반 영구 저장** 패턴으로 교체하여, 게이트웨이 재시작 후에도 진행 중이던 A2A 대화를 재개할 수 있도록 함.

## 핵심 변경 사항

### Phase 1: A2AJobManager (영구 저장소)

- **`src/agents/tools/a2a-job-manager.ts`** (~255 LOC, 신규)
  - `A2AJobStatus` 타입: `PENDING | RUNNING | COMPLETED | FAILED | ABANDONED`
  - `A2AJobRecord` 인터페이스: 잡 메타데이터 + 현재 진행 턴 + 타이밍
  - `A2AJobManager` 클래스: CRUD + 상태 전이 + 턴 진행 기록 + 스테일 감지 + 7일 TTL 정리
  - Singleton: `initA2AJobManager()` / `getA2AJobManager()` / `resetA2AJobManager()`
  - Atomic write: `.tmp` + `rename` 패턴
- **27 단위 테스트** 통과

### Phase 2: A2AJobReaper (시작 시 복구)

- **`src/agents/tools/a2a-job-reaper.ts`** (~100 LOC, 신규)
  - `runOnStartup()`: 미완료 잡 스캔 → 스테일(1시간+) ABANDONED → 나머지 RUNNING→PENDING
  - `getResumableJobs()`: PENDING 잡 목록 반환
  - `ReaperResult`: 처리 통계
- **8 단위 테스트** 통과

### Phase 3: runSessionsSendA2AFlow() 인터페이스 확장

- **`src/agents/tools/sessions-send-tool.a2a.ts`** (수정)
  - 선택적 파라미터 3개 추가: `startTurn?`, `signal?`, `onTurnComplete?`
  - Ping-pong 루프에 AbortSignal 체크 추가
  - 각 턴 완료 후 `onTurnComplete(turn)` 콜백 호출
  - 기존 호출 코드 호환성 유지 (모든 새 파라미터 선택적)

### Phase 4: A2AJobOrchestrator (브릿지 모듈)

- **`src/agents/tools/a2a-job-orchestrator.ts`** (~150 LOC, 신규)
  - `createAndStartFlow()`: 잡 생성 → PENDING → RUNNING → 플로우 실행 → COMPLETED/FAILED
  - `resumeFlows()`: PENDING 잡 배열 받아 순차 재개
  - Fallback: JobManager 미초기화 시 기존 직접 실행 (하위 호환)
  - 순환 의존 방지: `a2a-job-manager` ↔ `sessions-send-tool.a2a` 사이 분리
- **8 단위 테스트** 통과

### Phase 5: Fire-and-forget 패턴 교체

- **`src/agents/tools/sessions-send-tool.ts`** (수정)
  - `import { runSessionsSendA2AFlow }` → `import { createAndStartFlow }`
  - `void runSessionsSendA2AFlow({...})` → `void createAndStartFlow({ jobId: runId, ...})`
- **`src/discord/monitor/message-handler.process.ts`** (수정)
  - 동일한 import/호출 교체

### Phase 6: 게이트웨이 시작 연결

- **`src/gateway/server-startup.ts`** (수정)
  - `stateDir`를 function scope로 이동 (기존 try 블록 스코프 버그 수정)
  - `initA2AJobManager(stateDir)` + `init()` 호출
  - `A2AJobReaper.runOnStartup()` 실행
  - `resumeFlows(resumable)` 호출 (비동기, 논블로킹)

## 아키텍처

```
sessions-send-tool.ts ──┐
                        ├─→ createAndStartFlow() ──→ A2AJobManager.createJob()
message-handler.process.ts ─┘                     ├─→ A2AJobManager.updateStatus(RUNNING)
                                                   └─→ runSessionsSendA2AFlow({
                                                          ...params,
                                                          startTurn,
                                                          signal,
                                                          onTurnComplete
                                                        })
                                                        ├─→ A2AJobManager.recordTurnProgress()
                                                        ├─→ A2AJobManager.completeJob()
                                                        └─→ A2AJobManager.failJob()

Gateway Startup:
  initA2AJobManager(stateDir)
  → A2AJobReaper.runOnStartup()
    → stale jobs → ABANDONED
    → non-stale RUNNING → PENDING
  → resumeFlows(pendingJobs)
    → createAndStartFlow() for each
```

## 파일 저장 위치

`~/.openclaw/a2a-jobs/job-{jobId}.json`

## 테스트 결과

| 파일                             | 테스트 수 | 결과                         |
| -------------------------------- | --------- | ---------------------------- |
| `a2a-job-manager.test.ts`        | 27        | ✅ 통과                      |
| `a2a-job-reaper.test.ts`         | 8         | ✅ 통과                      |
| `a2a-job-orchestrator.test.ts`   | 8         | ✅ 통과                      |
| `sessions-send-tool.a2a.test.ts` | 8/14      | ✅ (6 pre-existing failures) |
| TypeScript `--noEmit`            | —         | ✅ 변경 파일 에러 없음       |

## 설계 문서 대비 차이점

1. **A2AJobRunner 별도 클래스 → A2AJobOrchestrator 모듈**: 설계 문서에서는 `A2AJobRunner`라는 별도 클래스를 제안했으나, 순환 의존 방지를 위해 `a2a-job-orchestrator.ts` 모듈로 구현. 기능적으로 동일.
2. **startTurn 활용**: 현재 `startTurn`은 인터페이스에 추가되었으나, `runSessionsSendA2AFlow` 내부에서 아직 "턴 건너뛰기" 로직으로 사용하지 않음 (ping-pong 루프는 항상 turn 1부터 시작). 향후 개선 가능.
3. **잡 취소 API**: 설계 문서의 "향후 확장"에 언급된 `cancelJob()` — AbortController는 준비되어 있으나, 외부 호출 API는 미구현.

## 향후 개선

- `startTurn` 기반 턴 건너뛰기 (이미 완료된 턴 스킵)
- 외부 잡 취소 API (`cancelJob(jobId)` → AbortController.abort())
- Task-Hub에서 A2A 잡 상태 조회
- `openclaw a2a jobs` CLI 명령
