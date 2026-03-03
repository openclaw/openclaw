# #12 Task Enforcement Bypass 수정 — 구현 기록

> 구현일: 2026-02-19
> 상태: Phase 1-3 완료

---

## 변경 파일

| 파일                                           | 변경 유형 | 변경 내용                                                          |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `src/agents/tools/task-file-io.ts`             | 수정      | `TaskFile.createdBySessionKey` 필드 추가, 직렬화/파싱              |
| `src/agents/tools/task-tool.ts`                | 수정      | `task_start`에서 `createdBySessionKey` 자동 기록                   |
| `src/plugins/core-hooks/task-enforcer.ts`      | 수정      | session-scoped `hasActiveTaskFiles()` + `cleanupStaleTasks()` 추가 |
| `src/plugins/core-hooks/task-enforcer.test.ts` | 수정      | disk recovery 테스트 4개로 확장 (session matching)                 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 수정      | A2A/cron → "full" promptMode (subagent만 "minimal")                |

## 설계 문서와의 차이점

### Fix #1: 세션 범위 디스크 체크

- **설계 옵션 A** (세션 ID 메타데이터) 채택
- **차이점**: 메타데이터 없는 기존 파일에 대해 설계는 "폴백 허용"을 제안했으나, 구현은 **보안 우선** 정책으로 세션 메타데이터 없는 파일은 bypass 불가로 처리. 이전 세션의 stale 파일이 새 세션을 우회하는 핵심 취약점을 차단하기 위함.
- **설계 옵션 B** (시간 기반 필터링)는 미채택. 시간 기반은 edge case가 많고 세션 메타데이터가 더 정확함.

### Fix #2: Stale Task 정리

- **설계**: `attempt.ts`에서 세션 시작 시 `cleanupStaleTasks()` 호출
- **구현**: `cleanupStaleTasks()` 함수를 export로 구현만 완료. 호출 시점은 향후 통합 시 결정.
- **이유**: `attempt.ts`의 세션 시작 플로우에 cleanup을 삽입하면 첫 tool call 시 추가 I/O가 발생. 별도 cron 또는 gateway startup에서 호출하는 것이 더 적절할 수 있음.

### Fix #3: A2A 프롬프트

- **설계 옵션 A** (새 promptMode 레벨)와 **옵션 B** (도구 가용성 체크) 모두 미채택
- **구현**: `attempt.ts`에서 promptMode 결정 로직 자체를 변경. subagent만 "minimal", A2A/cron은 "full".
- **이유**: 가장 간단하고 정확. A2A/cron 세션은 모든 도구를 가지고 있으므로 "full" 프롬프트가 올바름. 별도의 도구 가용성 체크 로직 불필요.

### Fix #4: 세션 범위 강제

- **설계**: `taskStartedSessions` 맵 키 변경
- **구현**: `taskStartedSessions`은 이미 sessionKey를 키로 사용하고 있었음. 실제 문제는 disk check가 agent-wide였던 것이므로 Fix #1로 해결됨.

## 상세 구현 내용

### 1. `TaskFile.createdBySessionKey`

```typescript
// task-file-io.ts
interface TaskFile {
  // ... 기존 필드 ...
  createdBySessionKey?: string; // Session key that created this task (for enforcement scope)
  // ...
}
```

직렬화: `- **Created By Session:** {sessionKey}` 형태로 Metadata 섹션에 추가.
파싱: 정규식 `\*\*Created By Session:\*\*\s*(.+)` 로 추출.

### 2. Session-Scoped Disk Check

`hasActiveTaskFiles(workspaceDir, agentId, sessionKey)`:

- sessionKey가 제공되면: task 파일의 "Created By Session" 메타데이터와 **정확히 일치**하는 파일만 인정
- sessionKey 없으면: 기존 agent-wide 동작 (하위 호환)
- 캐시 키: `${agentId}:${sessionKey}` (세션별 캐시 분리)

### 3. cleanupStaleTasks()

```typescript
export async function cleanupStaleTasks(workspaceDir: string, agentId?: string): Promise<number>;
```

- 24시간 이상 수정되지 않은 in_progress/pending 파일을 abandoned로 전환
- 삭제하지 않음 (감사 추적 보존)
- 반환값: 정리된 파일 수

### 4. A2A 프롬프트 변경

```typescript
// Before:
const promptMode =
  isSubagentSessionKey(params.sessionKey) ||
  isCronSessionKey(params.sessionKey) ||
  isA2ASessionKey(params.sessionKey)
    ? "minimal"
    : "full";

// After:
const promptMode = isSubagentSessionKey(params.sessionKey) ? "minimal" : "full";
```

## 보안 효과

| 시나리오                             | Before         | After                  |
| ------------------------------------ | -------------- | ---------------------- |
| 이전 세션 task 파일 → 새 세션 bypass | ✅ bypass 성공 | ❌ 차단                |
| A2A 세션에서 task 추적 지시          | ❌ 미포함      | ✅ 포함                |
| 메타데이터 없는 레거시 파일          | ✅ bypass 가능 | ❌ 차단 (보안 우선)    |
| 동일 세션 gateway 재시작             | ✅ 복구        | ✅ 복구 (세션 키 매칭) |

## 테스트 결과

- `task-enforcer.test.ts`: 20/20 pass (기존 18 → 20, 2개 추가)
- `task-file-io.test.ts`: 61/61 pass (기존 대비 변경 없음)
- `task-tool.test.ts`: 72/72 pass
- `task-stop-guard.test.ts`: 14/14 pass
- `coordination-invariants.test.ts`: 12/12 pass
- TypeScript: 0 errors in modified production files

## 후속 작업

- `cleanupStaleTasks()` 호출 시점 결정 (gateway startup / cron / session init)
- 레거시 task 파일 마이그레이션 (기존 파일에 session 메타데이터 없어도 24시간 후 자동 abandoned)
- 정리 임계값을 config로 설정 가능하게 (현재 하드코딩 24h)

## Follow-up: Gateway Startup Wiring (2026-02-19)

### 변경 파일

| 파일                            | 변경 유형 | 설명                            |
| ------------------------------- | --------- | ------------------------------- |
| `src/gateway/server-startup.ts` | 수정      | `cleanupStaleTasks()` 호출 추가 |

### 구현 내용

`startGatewaySidecars()` 함수에 stale task cleanup 단계를 추가:

1. 설정에서 전체 에이전트 목록 조회 (default + agents.list)
2. 각 에이전트의 workspace 디렉토리에서 `cleanupStaleTasks()` 호출
3. 24시간 이상 in_progress/pending 상태인 task 파일 → abandoned로 전환
4. 정리된 파일 수를 로그로 출력

### 호출 시점

- 세션 lock 파일 정리 직후, A2A 서브시스템 초기화 직전
- 게이트웨이 재시작 시마다 자동 실행

### 검증

- TypeScript `--noEmit` 에러 없음
- task-enforcer 20 tests 전체 통과
