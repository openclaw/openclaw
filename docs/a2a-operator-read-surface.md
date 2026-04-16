# A2A Operator Read Surface — 설계 초안 v2

작성: 등애 | 일자: 2026-04-16 | 대상: src/agents/a2a/{list,status}, gateway schema, dashboard payload
v2: 서서 리뷰 반영 — stale 수치 명시, 필드 중복 규칙, category↔workerView 매핑표 추가

---

## 1. 현재 상태 분석

### 1.1 기존 statusCategory (3분류)

```ts
type A2ATaskStatusCategory = "active" | "terminal-success" | "terminal-failure";
```

`classifyA2AExecutionStatus()`에서 다음과 같이 매핑:

| executionStatus                                    | category         |
| -------------------------------------------------- | ---------------- |
| accepted, running, waiting_reply, waiting_external | active           |
| completed                                          | terminal-success |
| failed, timed_out, cancelled                       | terminal-failure |

### 1.2 기존 ProtocolStatus 필드

```ts
type A2ATaskProtocolStatus = {
  taskId;
  correlationId?;
  parentRunId?;
  requester?;
  target;
  executionStatus;
  deliveryStatus;
  summary?;
  output?;
  error?;
  updatedAt;
  startedAt?;
  heartbeatAt?;
  hasHeartbeat;
};
```

### 1.3 문제점

- **operator는 3분류만으로 "어디서 막혔는지" 판단 불가**: `active` 안에 accepted(아직 시작 안함), running(실행 중), waiting_reply(응답 대기), waiting_external(외부 의존)이 섞임
- **연구 워커 관점 분류 없음**: broker 대기, worker 실행 중, announce 대기, remote failure, protocol mismatch 등 구분 없음
- **대시보드 필드 미정**: 어떤 API에서 어떤 shape를 반환하는지 명시 안 됨
- **polling vs event 미명시**

---

## 2. 개선안: Operator Status Category 확장

### 2.1 새 statusCategory (6분류)

```ts
export type A2ATaskStatusCategory =
  | "active" // 실행 중/진행 중 (기존 유지)
  | "terminal-success" // 성공 완료 (기존 유지)
  | "terminal-failure" // 실패/취소/타임아웃 (기존 유지)
  | "waiting-external" // 외부 의존 대기 (신규)
  | "canceled" // 취소 (신규, terminal-failure에서 분리)
  | "stale"; // heartbeat 없이 오래된 active (신규)
```

### 2.2 연구 워커 분류 (연산 필드)

executionStatus + heartbeat + 시간 조합으로 도출하는 **derived category**:

```ts
export type A2ATaskWorkerView =
  | "broker-queued" // accepted, worker.started 미발생
  | "worker-running" // running, 최근 heartbeat 있음
  | "worker-stale" // running, heartbeat 없이 N초 경과
  | "waiting-reply" // waiting_reply
  | "waiting-external" // waiting_external
  | "announce-pending" // completed이지만 deliveryStatus=pending
  | "announce-sent" // completed + deliveryStatus=sent
  | "remote-failure" // failed/timed_out + error message
  | "local-mismatch" // completed이지만 output 없고 error도 없는 비정상 상태
  | "done"; // 정상 완료
```

### 2.3 분류 규칙

```
executionStatus       | heartbeat | deliveryStatus   | category          | workerView
---------------------|-----------|------------------|-------------------|-----------------
accepted             | -         | -                | active            | broker-queued
running              | fresh     | -                | active            | worker-running
running              | stale     | -                | stale             | worker-stale
waiting_reply        | -         | -                | waiting-external  | waiting-reply
waiting_external     | -         | -                | waiting-external  | waiting-external
completed            | -         | pending          | active            | announce-pending
completed            | -         | sent             | terminal-success  | announce-sent
completed            | -         | skipped/none     | terminal-success  | done
completed            | -         | failed           | terminal-failure  | remote-failure
failed               | -         | -                | terminal-failure  | remote-failure
timed_out            | -         | -                | terminal-failure  | remote-failure
cancelled            | -         | -                | canceled          | done (취소됨)
```

**heartbeat fresh/stale 기준**: §3.4 Stale 판정 기준 참조.

---

## 3. Stale 판정 기준 수치

### 3.1 기준값 정의

| 파라미터                    | 기본값            | 설명                                                      | 설정 가능     |
| --------------------------- | ----------------- | --------------------------------------------------------- | ------------- |
| `STALE_HEARTBEAT_MS`        | **120,000** (2분) | 마지막 heartbeat으로부터 stale 판정까지의 시간            | ✅ env/config |
| `STALE_CRITICAL_MS`         | **300,000** (5분) | stale에서 critical 승격까지의 시간                        | ✅ env/config |
| `STALE_RUNNING_NO_HB_MS`    | **180,000** (3분) | running 상태에서 heartbeat이 한 번도 없었을 때 stale 판정 | ✅ env/config |
| `DELIVERY_PENDING_STALE_MS` | **60,000** (1분)  | announce-pending(완료인데 배달 안 됨)에서 alert 발생      | ✅ env/config |

### 3.2 Stale 판정 로직

```ts
function isTaskStale(record: A2ATaskRecord, now: number, config: StaleConfig): boolean {
  // 1. running 상태에서 heartbeat 없이 STALE_RUNNING_NO_HB_MS 경과
  if (record.execution.status === "running" && record.execution.heartbeatAt === undefined) {
    return now - record.execution.startedAt > config.STALE_RUNNING_NO_HB_MS;
  }
  // 2. heartbeat 있으나 STALE_HEARTBEAT_MS 이상 갱신 없음
  if (record.execution.heartbeatAt !== undefined) {
    return now - record.execution.heartbeatAt > config.STALE_HEARTBEAT_MS;
  }
  // 3. accepted 상태에서 STALE_HEARTBEAT_MS 이상 상태 변화 없음
  if (record.execution.status === "accepted") {
    return now - record.execution.updatedAt > config.STALE_HEARTBEAT_MS;
  }
  return false;
}

function isStaleCritical(staleAgeMs: number, config: StaleConfig): boolean {
  return staleAgeMs > config.STALE_CRITICAL_MS;
}
```

### 3.3 StaleConfig 타입

```ts
export type StaleConfig = {
  STALE_HEARTBEAT_MS: number; // default 120_000
  STALE_CRITICAL_MS: number; // default 300_000
  STALE_RUNNING_NO_HB_MS: number; // default 180_000
  DELIVERY_PENDING_STALE_MS: number; // default 60_000
};

export const DEFAULT_STALE_CONFIG: StaleConfig = {
  STALE_HEARTBEAT_MS: 120_000,
  STALE_CRITICAL_MS: 300_000,
  STALE_RUNNING_NO_HB_MS: 180_000,
  DELIVERY_PENDING_STALE_MS: 60_000,
};
```

### 3.4 수치 선택 근거

| 수치                   | 근거                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| 2분 (heartbeat stale)  | OpenClaw heartbeat 간격 ~30초 기준, 4회 miss 후 stale. 일반적인 LLM turn 소요시간(30-90초) 고려. |
| 5분 (critical)         | 10회 miss. worker 프로세스 장애 가능성 높음. operator 개입 필요.                                 |
| 3분 (running no-hb)    | worker.started 후 첫 heartbeat까지 여유. 네트워크 지연/초기 로딩 고려.                           |
| 1분 (delivery pending) | completed 후 announce 발행까지 정상 경로는 수초 내. 1분 초과는 비정상.                           |

---

## 4. 대시보드 필드 설계

### 4.1 List API — `a2a.task.list`

**목적**: 전체 태스크 목록. operator가 병목을 빠르게 파악.

```ts
export type A2ATaskListParams = {
  sessionKey: string;
  statusFilter?: A2ATaskStatusCategory | A2ATaskStatusCategory[];
  workerViewFilter?: A2ATaskWorkerView | A2ATaskWorkerView[];
  limit?: number; // default 50
  cursor?: string; // pagination (taskId-based)
};

export type A2ATaskListItem = {
  // 식별
  taskId: string;
  correlationId?: string;

  // 당사자
  requester?: {
    sessionKey: string;
    displayKey: string;
    channel?: string;
  };
  target: {
    sessionKey: string;
    displayKey: string;
    channel?: string;
  };

  // 상태 (operator 시야)
  executionStatus: A2AExecutionStatus;
  statusCategory: A2ATaskStatusCategory;
  workerView: A2ATaskWorkerView;

  // 타이밍 (operator 핵심)
  createdAt: number; // task 생성 시각
  startedAt?: number; // worker 시작 시각
  heartbeatAt?: number; // 마지막 heartbeat
  updatedAt: number; // 마지막 상태 변화
  completedAt?: number; // 완료 시각

  // 배달
  deliveryStatus: A2ADeliveryStatus;

  // 결과 요약
  summary?: string; // 마지막 reply/announce 요약 (최대 200자)
  errorCode?: string;
  errorMessage?: string;

  // 우선순위
  priority?: "low" | "normal" | "high";
  intent?: A2ATaskIntent;
};
```

**응답 shape**:

```ts
export type A2ATaskListResult = {
  tasks: A2ATaskListItem[];
  total: number; // 필터 적용 전 총수
  filtered: number; // 필터 적용 후 수
  cursor?: string; // 다음 페이지
};
```

### 4.2 Detail API — `a2a.task.detail`

**목적**: 단일 태스크 상세. "지금 어디서 막혔는지" 5초 안에 판단.

```ts
export type A2ATaskDetailItem = A2ATaskListItem & {
  // ProtocolStatus 전체
  protocolStatus: A2ATaskProtocolStatus;

  // 진행 상세
  intent: A2ATaskIntent;
  instructions: string; // 원본 지시
  input?: Record<string, unknown>;
  expectedOutput?: {
    format: "text" | "json";
    schemaName?: string;
  };

  // 제약
  timeoutSeconds?: number;
  maxPingPongTurns?: number;
  requireFinal?: boolean;
  allowAnnounce?: boolean;

  // 실행 상세
  acceptedAt?: number;
  lastReplySummary?: string; // worker의 마지막 응답 요약

  // 결과 (완료된 경우)
  output?: unknown;

  // 에러 상세
  error?: {
    code: string;
    message?: string;
  };

  // 배달 상세
  delivery: {
    mode: A2ADeliveryMode;
    status: A2ADeliveryStatus;
    updatedAt?: number;
    errorMessage?: string;
  };

  // 진단 정보
  diagnostics: {
    ageMs: number; // now - createdAt
    executionDurationMs?: number; // completedAt - startedAt
    lastHeartbeatAgeMs?: number; // now - heartbeatAt
    isStale: boolean; // heartbeat 기준 초과 여부
    pendingSinceMs?: number; // deliveryStatus=pending인 시간
  };
};
```

### 4.3 대시보드 요약 API — `a2a.dashboard`

**목적**: 상태판. 전체 시스템 건강도를 한 번에.

```ts
export type A2ADashboardSummary = {
  timestamp: number;

  // 상태 분포
  counts: {
    total: number;
    active: number;
    waitingExternal: number;
    stale: number;
    terminalSuccess: number;
    terminalFailure: number;
    canceled: number;
  };

  // workerView 분포
  workerCounts: Record<A2ATaskWorkerView, number>;

  // 주의 필요
  alerts: A2ADashboardAlert[];

  // 최근 활동
  recentTasks: A2ATaskListItem[]; // 최근 10건 (updatedAt desc)
};

export type A2ADashboardAlert = {
  taskId: string;
  severity: "warning" | "critical";
  type: "stale-heartbeat" | "long-running" | "delivery-failed" | "repeated-failure";
  message: string;
  since: number; // 알림 조건 발생 시각
};
```

---

## 5. 필드 중복 규칙

### 5.1 원칙: 각 API 뷰는 자족적(self-contained)이어야 한다.

operator는 단일 API 응답만으로 판단해야 하며, 다른 API를 조합할 필요가 없다.
필드 중복은 **명시적 허용**. 중복이 성능/네트워크 비용보다 operator 인지 부하 감소에 더 가치 있음.

### 5.2 필드 포함 규칙

| 필드 그룹                                                        | List                                 | Detail    | Dashboard            | Status (기존)              |
| ---------------------------------------------------------------- | ------------------------------------ | --------- | -------------------- | -------------------------- |
| **식별**: taskId, correlationId                                  | ✅                                   | ✅        | ✅ (recentTasks에만) | ✅                         |
| **당사자**: requester, target                                    | ✅ 요약                              | ✅ 전체   | ✅ (recentTasks에만) | ✅                         |
| **상태**: executionStatus, statusCategory, workerView            | ✅                                   | ✅        | ❌ (counts로 대체)   | ✅ (executionStatus만)     |
| **타이밍**: createdAt, updatedAt                                 | ✅                                   | ✅        | ❌                   | ✅                         |
| **타이밍 상세**: startedAt, heartbeatAt, completedAt, acceptedAt | ✅ startedAt/heartbeatAt/completedAt | ✅ 전체   | ❌                   | ✅ startedAt/heartbeatAt   |
| **배달**: deliveryStatus                                         | ✅                                   | ✅        | ❌                   | ✅                         |
| **배달 상세**: delivery.mode, delivery.errorMessage              | ❌                                   | ✅        | ❌                   | ❌                         |
| **결과 요약**: summary                                           | ✅ (≤200자)                          | ✅ (전체) | ❌                   | ✅                         |
| **에러 요약**: errorCode, errorMessage                           | ✅                                   | ✅        | ❌ (alerts에만)      | ✅ (error 객체)            |
| **우선순위**: priority, intent                                   | ✅                                   | ✅        | ❌                   | ❌                         |
| **진단**: diagnostics                                            | ❌                                   | ✅        | ❌                   | ❌                         |
| **envelope 원본**: instructions, input, constraints              | ❌                                   | ✅        | ❌                   | ❌                         |
| **ProtocolStatus 전체**                                          | ❌                                   | ✅ 포함   | ❌                   | ✅ (자체가 ProtocolStatus) |
| **output**                                                       | ❌                                   | ✅        | ❌                   | ✅                         |

### 5.3 필드 포함 규칙 (요약)

1. **List**: 목록 스캔에 필요한 최소 집합. 스캔 속도 > 정보량. summary는 200자 truncation.
2. **Detail**: List의 상위집합(superset). 문제 진단에 필요한 모든 정보. **ProtocolStatus 전체를 포함**하므로 기존 `a2a.task.status` 호출 불필요.
3. **Dashboard**: 집계 + alerts + 최근 10건. 개별 태스크 상세는 List/Detail로 위임.
4. **Status (기존)**: 변경 없음. ProtocolStatus 단일 객체 반환.

### 5.4 중복 필드의 일관성 규칙

- 동일 필드명 → **동일 타입, 동일 의미**. API 간 값이 달라서는 안 됨.
- Detail이 List 필드를 포함할 때 → **값이 완전히 동일** (동일 record에서 도출).
- `summary` truncation: List만 200자 제한. Detail은 원문.
- `diagnostics`는 Detail 전용. List에서 제외 이유: N건마다 now 연산 비용 + 목록에서 불필요.

---

## 6. Status Category ↔ WorkerView 매핑표

### 6.1 전체 매트릭스

| #   | executionStatus  | heartbeat            | deliveryStatus | category             | workerView            | operator 판단                                     |
| --- | ---------------- | -------------------- | -------------- | -------------------- | --------------------- | ------------------------------------------------- |
| 1   | accepted         | -                    | -              | **active**           | **broker-queued**     | 브로커에 등록됨. worker 미할당/미시작. 정상 대기. |
| 2   | accepted         | -                    | -              | **stale**¹           | **broker-queued**     | 오래된 accepted. worker 할당 실패 가능.           |
| 3   | running          | fresh (<120s)        | -              | **active**           | **worker-running**    | 정상 실행 중.                                     |
| 4   | running          | stale (≥120s)        | -              | **stale**            | **worker-stale**      | heartbeat 누락. worker 장애 의심.                 |
| 5   | running          | no heartbeat (≥180s) | -              | **stale**            | **worker-stale**      | 시작 후 heartbeat 미수신. 네트워크/프로세스 장애. |
| 6   | waiting_reply    | -                    | -              | **waiting-external** | **waiting-reply**     | worker 응답 대기. requester/reply 단계. 정상.     |
| 7   | waiting_external | -                    | -              | **waiting-external** | **waiting-external**  | 외부 의존 대기 (API, 파일, 승인 등).              |
| 8   | completed        | -                    | pending        | **active**           | **announce-pending**  | 작업 완료. 배달 대기.                             |
| 9   | completed        | -                    | pending (≥60s) | **active**           | **announce-pending**² | 배달 지연. announce 실패 가능.                    |
| 10  | completed        | -                    | sent           | **terminal-success** | **announce-sent**     | 완료 + 배달 성공.                                 |
| 11  | completed        | -                    | skipped/none   | **terminal-success** | **done**              | 완료 (배달 미필요).                               |
| 12  | completed        | -                    | failed         | **terminal-failure** | **remote-failure**    | 작업 성공이나 배달 실패.                          |
| 13  | failed           | -                    | -              | **terminal-failure** | **remote-failure**    | 실행 실패. errorCode 확인.                        |
| 14  | timed_out        | -                    | -              | **terminal-failure** | **remote-failure**    | 타임아웃. timeoutSeconds 초과.                    |
| 15  | cancelled        | -                    | -              | **canceled**         | **done**              | 취소됨.                                           |
| 16  | completed        | -                    | -              | **terminal-success** | **local-mismatch**³   | 완료인데 output/error 모두 없음. 비정상.          |

**주석**:

- ¹ `updatedAt - createdAt > STALE_HEARTBEAT_MS`인 accepted → stale category로 승격. workerView는 broker-queued 유지.
- ² announce-pending이지만 `delivery.updatedAt`으로부터 `DELIVERY_PENDING_STALE_MS` 초과 시 alert 발생.
- ³ `output === undefined && error === undefined && deliveryStatus ∈ {skipped, none}`인 completed. 정상 완료와 구분.

### 6.2 Category → WorkerView 관계 (다대다)

```
category            │ possible workerViews
────────────────────│─────────────────────────────────────
active             │ broker-queued, worker-running, announce-pending
stale              │ broker-queued, worker-stale
waiting-external   │ waiting-reply, waiting-external
terminal-success   │ announce-sent, done, local-mismatch
terminal-failure   │ remote-failure
canceled           │ done
```

### 6.3 WorkerView → Category 관계 (다대일)

```
workerView          │ unique category
────────────────────│─────────────────
broker-queued       │ active (또는 stale)
worker-running      │ active
worker-stale        │ stale
waiting-reply       │ waiting-external
waiting-external    │ waiting-external
announce-pending    │ active
announce-sent       │ terminal-success
done                │ terminal-success (또는 canceled)
remote-failure      │ terminal-failure
local-mismatch      │ terminal-success
```

### 6.4 Alert 규칙 (수치 반영)

| type               | 조건                                                                                          | severity 승격                                    |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| stale-heartbeat    | `lastHeartbeatAgeMs ≥ STALE_HEARTBEAT_MS (120s)`                                              | warning → critical: `≥ STALE_CRITICAL_MS (300s)` |
| stale-no-start     | `running && heartbeatAt === undefined && (now - startedAt) ≥ STALE_RUNNING_NO_HB_MS (180s)`   | critical (즉시)                                  |
| stale-broker-queue | `accepted && (now - updatedAt) ≥ STALE_HEARTBEAT_MS (120s)`                                   | warning (즉시)                                   |
| long-running       | `executionDurationMs > timeoutSeconds * 1000`                                                 | critical (즉시)                                  |
| delivery-delayed   | `announce-pending && (now - delivery.updatedAt) ≥ DELIVERY_PENDING_STALE_MS (60s)`            | warning (즉시)                                   |
| delivery-failed    | `deliveryStatus = failed`                                                                     | critical (즉시)                                  |
| repeated-failure   | 동일 target.sessionKey에 최근 1시간 내 ≥3건 terminal-failure                                  | warning (즉시)                                   |
| local-mismatch     | `completed && output === undefined && error === undefined && deliveryStatus ∈ {skipped,none}` | warning (즉시)                                   |

---

## 7. API별 Shape 요약

| API       | method             | params                             | result                                    | polling     | event    |
| --------- | ------------------ | ---------------------------------- | ----------------------------------------- | ----------- | -------- |
| List      | `a2a.task.list`    | sessionKey, filters, limit, cursor | `{ tasks[], total, filtered, cursor? }`   | ✅ 30s 권장 | ❌       |
| Detail    | `a2a.task.detail`  | sessionKey, taskId                 | `A2ATaskDetailItem` (ProtocolStatus 포함) | ✅ 필요시   | ❌       |
| Status    | `a2a.task.status`  | sessionKey, taskId                 | `A2ATaskProtocolStatus`                   | ✅          | ❌       |
| Dashboard | `a2a.dashboard`    | sessionKey?                        | `A2ADashboardSummary`                     | ✅ 30s 권장 | SSE 추후 |
| Request   | `a2a.task.request` | request envelope                   | `A2ATaskRequestResult`                    | -           | -        |
| Update    | `a2a.task.update`  | update params                      | `A2ATaskUpdateResult`                     | -           | -        |
| Cancel    | `a2a.task.cancel`  | cancel params                      | `A2ATaskCancelResult`                     | -           | -        |

### Polling vs Event

- **현재 (Phase 1)**: Polling 기반. List/Dashboard는 30초 주기 권장.
- **Phase 2 (계획)**: SSE 기반 task event stream. `a2a.tasks.subscribe` → event push.
- **이유**: 현재 JSON-RPC 레이어에 SSE 연동이 없음. dashboard에서 긴급 상태 변화를 감지하려면 polling으로 충분. Phase B에서 SSE 파이프라인과 연결 예정.

---

## 8. 변경 영향 분석

### 8.1 수정 파일

| 파일                                 | 변경 내용                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agents/a2a/types.ts`            | `A2ATaskStatusCategory` 확장 (6분류). `A2ATaskWorkerView` 신규. `StaleConfig` 신규.                                                                                                                                                                                |
| `src/agents/a2a/status.ts`           | `classifyA2ATaskStatusCategory()` 신규 (heartbeat + delivery 고려). `deriveA2ATaskWorkerView()` 신규. `isTaskStale()`, `isStaleCritical()` 신규. `DEFAULT_STALE_CONFIG` 상수. `A2ATaskStatusSnapshot`에 `statusCategory`, `workerView`, `priority`, `intent` 추가. |
| `src/agents/a2a/list.ts`             | `A2ATaskListItem` 타입 정의. `loadA2ATaskStatusIndex`가 workerView 포함. 필터에 workerViewFilter 추가. pagination cursor 지원.                                                                                                                                     |
| `src/gateway/protocol/schema/a2a.ts` | `a2a.task.list` params/result schema 추가. `a2a.task.detail` params/result schema 추가. `a2a.dashboard` params/result schema 추가.                                                                                                                                 |
| `src/gateway/server-methods/a2a.ts`  | `a2a.task.list`, `a2a.task.detail`, `a2a.dashboard` handler 추가.                                                                                                                                                                                                  |

### 8.2 기존 호환성

- `a2a.task.status` — **변경 없음**. ProtocolStatus 그대로 유지.
- `a2a.task.request/update/cancel` — **변경 없음**. 기존 레이어 그대로.
- `A2ATaskStatusCategory` — 기존 3값 유지 + 3값 추가. 하위 호환.
- `A2ATaskProtocolStatus` — **변경 없음**. detail에서 포함만 하면 됨.
- 기존 테스트 — status.test.ts의 `classifyA2AExecutionStatus`는 유지. 새 함수 추가로 검증.

---

## 9. 완료 기준

1. ✅ operator가 task 하나를 열면 "지금 어디서 막혔는지" 5초 안에 판단 가능
   - detail API의 `diagnostics` + `workerView` + `executionStatus` 조합으로 즉시 판단
2. ✅ 연구 워커 입장에서 active/blocked/failure 구분이 명확
   - `workerView` 10분류로 broker-queued / worker-running / worker-stale / waiting-reply / remote-failure 등 명확 구분
3. ✅ 대시보드에서 한 번에 시스템 상태 파악
   - `a2a.dashboard`의 counts + alerts + recentTasks
4. ✅ list/detail/dashboard 각각의 API shape가 명시됨
5. ✅ polling vs event 방식 명시

---

## 10. 향후 확장 (본 건 범위 밖)

- SSE 기반 `a2a.tasks.subscribe` (Phase B)
- Operator 액션: 재시도, 우선순위 변경, 강제 취소
- Worker fleet 상태 대시보드 (heartbeat 집계)
- 감사 로그 조회 API
