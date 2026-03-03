# Work Session 기반 3인+ 협업 설계 (이벤트 역할 재정의)

> 작성일: 2026-02-16
> 수정일: 2026-02-17
> 상태: 인프라 구현 완료 (2026-02-17 검증) — UI Phase C·D 미적용
> 대상: `prontolab-openclaw` + `task-hub`

## 0. 이벤트 역할 정의 (Role Contract)

이 문서의 선결정은 다음과 같다.

- `Conversations`는 **메인 에이전트 간 협업 대화**만 보여준다.
- subagent 위임/실행 이벤트는 `Conversations`가 아니라 `Events`/`Tasks` 관측으로 분리한다.

### 0.1 역할 분류

| role                   | 의미                                    | 대표 이벤트                                                   | Task-Hub 기본 소비자 |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------- | -------------------- |
| `conversation.main`    | 메인 에이전트 간 협업 대화              | `a2a.send`, `a2a.response`, `a2a.complete`(조건부)            | `Conversations`      |
| `delegation.subagent`  | 메인↔subagent 위임 및 하위 run 생명주기 | `a2a.spawn`, `a2a.spawn_result`, subagent 관련 `a2a.*`        | `Events`, `Tasks`    |
| `orchestration.task`   | 작업 상태 오케스트레이션                | `task.*`, `continuation.*`, `plan.*`, `unblock.*`, `zombie.*` | `Tasks`, 상태 배지   |
| `system.observability` | 운영/장애/동기화 신호                   | `milestone.sync_failed` 등                                    | 운영 대시보드        |

### 0.2 `conversation.main` 판정 규칙

이벤트가 아래를 모두 만족할 때만 `conversation.main`으로 본다.

1. 이벤트 타입이 `a2a.send | a2a.response | a2a.complete`
2. `fromAgent`, `toAgent`가 모두 메인 에이전트
3. subagent session key 문맥이 아님
4. `workSessionId`가 동일 협업 루트로 연결 가능

그 외는 `delegation.subagent` 또는 `orchestration.task`로 분류한다.

### 0.3 협업 카테고리 분류 (Collaboration Category)

`conversation.main` 내부에서도 협업 유형을 분리해 탐색 가능하도록 카테고리 축을 추가한다.

| category key         | 한국어 표시명     | 기본 의미                         |
| -------------------- | ----------------- | --------------------------------- |
| `engineering_build`  | 개발/구현         | 기능 개발, 리팩토링, 코드 변경    |
| `infra_ops`          | 인프라/운영       | 배포, 장애 대응, 환경 설정        |
| `qa_validation`      | QA/검증           | 테스트, 회귀 점검, 품질 확인      |
| `planning_decision`  | 기획/의사결정     | 설계, 우선순위, 정책 결정         |
| `research_analysis`  | 조사/분석         | 원인 분석, 옵션 비교, 사전 조사   |
| `docs_knowledge`     | 문서/지식화       | 가이드 작성, 변경 기록, 지식 정리 |
| `growth_marketing`   | 성장/마케팅       | 실험, 캠페인, 메시지 전략         |
| `customer_community` | 고객/커뮤니티     | CS, 커뮤니티 운영, 피드백 대응    |
| `legal_compliance`   | 법무/컴플라이언스 | 규정, 정책, 리스크 검토           |
| `biz_strategy`       | 비즈니스/전략     | KPI, 사업 전략, 의사결정 지원     |

운영 원칙:

- 상위 카테고리는 8~10개 고정(현재 10개)으로 유지한다.
- 세부 구분은 `subTags`로 확장한다.
- 카테고리는 1개 `primary` + N개 `secondary` 구조를 기본으로 한다.

## 1. 문제 정의

현재 협업 가시화는 `conversationId` 중심(주로 1:1 thread)으로 동작한다.
2인 협업은 보이지만, 3인 이상 fan-out/fan-in 협업에서는 다음 문제가 발생한다.

- 동일 작업인데 thread가 시간 기준으로 분리되어 "한 작업"으로 보이지 않음
- `Conversations` 목록이 구조(누가 누구를 spawn했는지)보다 시간 순서 중심으로만 보임
- `Tasks`와 `Conversations`가 약하게 연결되어 작업 추적이 끊김
- subagent 위임 이벤트가 대화와 섞여 "메인 협업 채팅" 의미가 희석됨

## 2. 목표 / 비목표

### 2.1 목표

- 협업 루트 식별자 `workSessionId`를 일관되게 사용
- 3인 이상 협업을 하나의 Work Session으로 안정적으로 묶기
- `Conversations`를 메인 에이전트 협업 채팅으로 명확히 고정
- 위임/작업 오케스트레이션 이벤트는 별도 뷰로 분리
- 기존 이벤트/로그/테스트/운영 체계와 역호환 유지

### 2.2 비목표

- 기존 이벤트 타입 전면 교체
- task 파일 포맷의 파괴적 변경
- 과거 로그 전체 재작성(backfill)

## 3. 확정된 의사결정

1. 루트 키: `workSessionId`
2. 생성 기준: `task_start` 우선, 없으면 첫 `sessions_spawn`에서 fallback 생성
3. `Conversations`는 `conversation.main` role만 소비
4. 상태 모델:
   - `ACTIVE`: 위임/작업 이벤트 기준 실행 중
   - `QUIET`: 하위 run 완료 후 무신규 활동
   - `ARCHIVED`: 24시간 무활동
5. 재작업 모델:
   - `QUIET` 중 이벤트 발생 시 동일 `workSessionId`를 `ACTIVE`로 복귀
   - `ARCHIVED` 후 재개는 신규 `workSessionId` 권장 + `previousWorkSessionId` 링크

## 4. 목표 아키텍처

```text
Task (taskId)
  -> Work Session (workSessionId)
       -> Main Conversations (conversation.main, conversationId N개)
       -> Delegations (delegation.subagent, spawn/run lifecycle)
       -> Orchestration Signals (task/continuation/plan/...)
```

핵심 원칙:

- `workSessionId`: 협업 작업 전체 루트
- `conversationId`: 대화 thread 단위
- `role`: 이벤트 소비처를 결정하는 1급 분류 키

## 5. 데이터 모델

### 5.1 이벤트 공통 확장 필드

`event.data` 확장 필드:

- `workSessionId: string`
- `rootTaskId?: string`
- `conversationId?: string`
- `parentConversationId?: string`
- `parentRunId?: string`
- `depth?: number`
- `hop?: number`
- `eventRole?: "conversation.main" | "delegation.subagent" | "orchestration.task" | "system.observability"`
- `fromSessionType?: "main" | "subagent" | "unknown"`
- `toSessionType?: "main" | "subagent" | "unknown"`
- `previousWorkSessionId?: string`
- `collabCategory?: "engineering_build" | "infra_ops" | "qa_validation" | "planning_decision" | "research_analysis" | "docs_knowledge" | "growth_marketing" | "customer_community" | "legal_compliance" | "biz_strategy"`
- `collabSubTags?: string[]`
- `collabIntent?: string`
- `categoryConfidence?: number` (0~1)
- `categorySource?: "manual" | "rule" | "heuristic" | "fallback"`
- `categoryVersion?: string`
- `categoryManualOverride?: boolean`

### 5.2 필드 의미

- `eventRole`: UI/집계에서 1차 분기 기준
- `fromSessionType`/`toSessionType`: 메인/서브 문맥을 명시
- `workSessionId`: thread 묶음 상위 루트
- `collabCategory`: 협업 주제의 상위 분류(단일 primary)
- `collabSubTags`: 세부 주제 태그(다중)
- `categorySource`/`categoryConfidence`: 분류 신뢰성과 출처

### 5.3 Task 파일 확장 (비파괴)

`TaskFile` 메모리 모델 선택 필드:

- `workSessionId?: string`
- `previousWorkSessionId?: string`

`## Metadata` 직렬화:

- `- **Work Session:** <id>`
- `- **Previous Work Session:** <id>`

## 6. ID 생성/전파 규칙

### 6.1 생성 규칙

1. `task_start` 호출 시 `workSessionId = ws_<uuid>` 생성
2. `sessions_spawn` 호출 시 우선순위

```text
explicit arg
 -> runtime inherited context
 -> current active task(workSessionId)
 -> create fallback ws_<uuid>
```

3. `task_start` 없는 협업도 첫 spawn에서 fallback 생성 허용

### 6.2 전파 규칙

- spawn 시점에서 생성/해석한 `workSessionId`를 모든 관련 이벤트에 전달
- child spawn은 부모 `workSessionId` 계승
- `depth = parent.depth + 1`

## 7. 상태머신

```text
            (all child runs completed / no orchestration events)
ACTIVE  -------------------------------------------------> QUIET
  ^                                                          |
  | (new delegation/orchestration/main conversation)         | (24h inactivity)
  +----------------------------------------------------------+
                           ARCHIVED
```

- `QUIET` 전환은 하위 run 완료 + 신규 이벤트 부재 기준
- `ARCHIVED`는 `lastActivity + 24h`

### 7.1 서버 판정 규칙 (구현 기준)

- `/api/work-sessions` 집계기는 `lastActivityMs = max(event timestamp)`로 세션 최신 활동 시각을 계산한다.
- `inactiveMs = nowMs - lastActivityMs`가 `24h`를 초과하면 `ARCHIVED`.
- `ARCHIVED`가 아니고 최신 이벤트가 terminal이면 `QUIET`.
  - terminal 예: `a2a.complete`, `a2a.spawn_result(status=error)`, terminal `task.*` 상태(`completed/cancelled/abandoned/failed`)
- 그 외는 `ACTIVE`.
- `QUIET`/`ARCHIVED` 세션도 신규 이벤트가 유입되면 최신 이벤트 기준으로 즉시 재판정되어 `ACTIVE`로 복귀할 수 있다.

## 8. UI 설계 (Task-Hub Conversations)

### 8.1 목록 구조

현재:

```text
Session(time-bucket)
  -> Thread(conversationId)
```

목표:

```text
Work Session(workSessionId)
  -> Conversation Thread(conversation.main only)
```

### 8.2 화면 책임 분리

- `Conversations`:
  - 메인 에이전트 간 대화만 표시
  - 제목은 작업 요약 1줄
- `Events`:
  - spawn/spawn_result 등 위임 흐름 상세
- `Tasks`:
  - task/continuation/plan/unblock/zombie 상태 추적

### 8.3 제목/요약 생성 우선순위

- 1순위: `label`
- 2순위: `[Goal] ...`
- 3순위: 첫 user-facing `message`/`replyPreview`
- 4순위: `협업 작업`

### 8.4 카테고리 탐색 UX

- 첫 진입 화면에서 10개 상위 카테고리를 **고정 배지 항목**으로 노출한다.
- 사용자는 필터 패널이 아니라 카테고리 배지를 선택해 해당 협업 뷰로 진입한다.
- `전체 보기`는 기본값이 아니라 별도 항목으로 제공한다.
- 세션 카드: `primary 카테고리 배지(한글)` + `subTags` 최대 2개
- 정렬: 기본 최신순, 보조로 카테고리별 묶음 보기 지원
- 수동 변경: 운영자가 카테고리 override 시 세션 집계 응답의 `categorySource=manual_override`로 기록

## 9. API / 백엔드 설계

### 9.1 확장 API

기존 유지:

- `GET /api/events?limit=...&since=...`

추가 권장:

- `GET /api/events?role=conversation.main`
- `GET /api/events?role=delegation.subagent`
- `GET /api/work-sessions?status=ACTIVE|QUIET|ARCHIVED&limit=...`
- `GET /api/work-sessions/:id` (요약 + thread index + role별 카운트)

- `GET /api/events?role=conversation.main&viewCategory=<collabCategory>`
- `GET /api/work-sessions?viewCategory=<collabCategory>&subTag=<tag>`
- `PATCH /api/work-sessions/:id/category` (운영자 수동 override)

### 9.2 클라이언트 규칙

- `Conversations`는 `role=conversation.main` 또는 동등한 서버 분류 결과만 사용
- 클라이언트의 ad-hoc 필터(타입 prefix만으로 판단)는 점진 제거
- 초기 카테고리 선택(배지 항목)은 서버 계산값(`collabCategory`)을 우선 사용하고, 클라이언트 추론은 fallback으로만 사용

### 9.3 카테고리 수동 Override 감사 규약

- Endpoint: `PATCH /api/work-sessions/:id/category`
- Request body: `{ collabCategory: <enum>, updatedBy?: string }`
- 저장소: `~/.openclaw/work-session-category-overrides.json`
- 서버가 `updatedAt`(ISO timestamp)을 강제 기록한다.
- `/api/work-sessions` 응답에서 override가 적용된 세션은:
  - `collabCategory`가 override 값으로 대체되고
  - `categorySource`는 `manual_override`로 반환된다.

## 10. 기존 시스템 연동 검토

### 10.1 OpenClaw

- `sessions_spawn`, `sessions_send`, `subagent_announce`, `continuation runner`에서
  `eventRole`, `fromSessionType`, `toSessionType`를 발행
- 기존 `a2a.*` 타입은 유지 (역호환)

### 10.2 Task-Hub

- Conversations는 role 기반 쿼리/필터로 고정
- Spawn 이벤트는 `Events`로 이동 링크 제공

### 10.3 역호환

- 구버전 이벤트(`eventRole` 없음)는 fallback 분류기 적용
- fallback 우선순위:
  1. session key 기반 main/subagent 판정
  2. agent allowlist 기반 판정
  3. 불명확 시 `delegation.subagent`로 보수적 분류

## 11. 리스크 및 완화

| 리스크               | 설명                             | 완화책                                       |
| -------------------- | -------------------------------- | -------------------------------------------- |
| role 누락 이벤트     | 일부 emit 지점 미반영            | CI에서 role 필수 필드 검증 테스트 추가       |
| 구버전 이벤트 오분류 | 기존 로그에 sessionType 부재     | fallback 분류 + Unknown 카운트 모니터링      |
| UI 의미 혼선         | Conversations에 위임 이벤트 유입 | role 기반 서버 필터 기본값 강제              |
| 장기 세션 상태 오차  | `limit=500` 기반 계산 편향       | `/api/work-sessions` 집계 endpoint 우선 사용 |

## 12. 테스트 전략

### 12.1 단위

- event role 분류기 테스트 (`conversation.main`/`delegation.subagent`)
- `sessions_spawn`/`sessions_send` emit payload에 role/sessionType 필드 검증
- task metadata parse/format 역직렬화 검증
- 카테고리 분류기 규칙/신뢰도/override 우선순위 검증

### 12.2 통합

- fan-out(1->3) + fan-in에서 role별 이벤트 분리 확인
- 메인↔메인 대화만 Conversations에 노출되는지 검증
- QUIET -> ACTIVE 재개, 24h -> ARCHIVED 전환 검증
- 다중 에이전트 조합에서 카테고리 안정성(동일 의도 -> 동일 primary) 검증

### 12.3 E2E

- Conversations: main-agent thread만 렌더링
- Events: spawn/subagent 이벤트 누락 없이 렌더링
- Tasks: orchestration 이벤트로 상태 배지가 일관되게 계산
- Conversations 카테고리 필터/배지/검색 결과가 API 분류와 일치하는지 검증

## 13. 단계별 구현 계획

### Phase A - 이벤트 계약

- emit payload에 `eventRole`, `fromSessionType`, `toSessionType` 추가
- parser/fallback 분류기 구현
- 카테고리 분류기(primary/subTags/confidence/source) 구현

### Phase B - 집계/API

- `/api/events?role=...` 추가
- `/api/work-sessions`에 role별 통계 포함
- `/api/events`, `/api/work-sessions`에 category 필터/집계 추가

### Phase C - UI 분리

- Conversations role 고정
- Events/Tasks와 링크 네비게이션 정리

### Phase D - 운영 안정화

- Unknown role 모니터링
- 장기 로그 성능 최적화
- 카테고리 분포 드리프트 모니터링(unknown/fallback 비율)

## 14. 수용 기준 (Definition of Done)

- `Conversations`가 메인 에이전트 협업 채팅만 보여준다.
- spawn/subagent 흐름은 `Events`/`Tasks`에서 추적 가능하다.
- 3인 이상 협업이 단일 `workSessionId`로 안정적으로 묶인다.
- 재작업/재개 흐름이 같은 세션 컨텍스트에서 끊기지 않는다.
- 구버전 이벤트도 fallback으로 깨지지 않고 표시된다.
- 카테고리 분류/필터 결과가 운영자가 이해 가능한 수준으로 안정적이다.
