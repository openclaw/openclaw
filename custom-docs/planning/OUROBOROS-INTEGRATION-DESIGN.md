# Ouroboros 통합 설계 — 분리 아키텍처 적용

> Ouroboros의 6-Phase 사이클을 Task Hub / Gateway / Agent 분리 아키텍처에 맞게 재설계한다.
> Ouroboros는 단일 프로세스 + 프롬프트 교체(역할 전환) 방식이지만,
> prontoclaw는 3-tier 분리 구조 + 다수 독립 에이전트이므로
> **전용 평가 에이전트**를 통해 LLM 판단을 분리한다.
>
> **상태**: 설계 문서 (구현 전 검토용)

---

## 1. 아키텍처 차이 분석

### Ouroboros (모놀리식)

```
┌─────────────────────────────────────────────────┐
│           Ouroboros (단일 프로세스)               │
│                                                 │
│  1 LLM 세션 × N 페르소나 (시스템 프롬프트 교체)  │
│                                                 │
│  Interview → Seed → Execute → Evaluate          │
│      ↑                           ↓              │
│      └──── Evolutionary Loop ────┘              │
│                                                 │
│  "9 Agents" = 9개 마크다운 프롬프트 파일         │
│  역할 전환: 같은 세션에서 프롬프트만 교체        │
│  EventStore (SQLite) 로 상태 추적               │
└─────────────────────────────────────────────────┘
```

### Prontoclaw (분리 아키텍처)

```
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Task Hub   │    │   Gateway    │    │   Agents (11+1)  │
│  (Next.js)  │◀──▶│ (prontoclaw) │◀──▶│                  │
│             │    │              │    │ 실행 에이전트 ×11 │
│ • UI/API    │    │ • 오케스트   │    │ 평가 에이전트 ×1  │
│ • MongoDB   │    │ • 도구 제공  │    │                  │
│ • 스펙 관리 │    │ • 프롬프트   │    │ 각각 독립 LLM 세션│
│ • 검증 추적 │    │ • 연속 실행  │    │ (별도 프로세스)   │
└─────────────┘    └──────────────┘    └──────────────────┘
```

### 핵심 차이점

| 측면              | Ouroboros                               | Prontoclaw                              |
| ----------------- | --------------------------------------- | --------------------------------------- |
| **에이전트 모델** | 1 프로세스 × N 페르소나 (프롬프트 교체) | N 프로세스 × 각각 독립 세션             |
| **실행 모델**     | 동기 파이프라인                         | 비동기 메시지 기반                      |
| **평가 주체**     | 같은 세션이 역할 전환하여 자체 평가     | **전용 평가 에이전트**가 별도 평가      |
| **상태 관리**     | SQLite EventStore                       | MongoDB (Task Hub) + TaskFile (Gateway) |
| **Phase 전환**    | 코드 내 함수 호출                       | 태스크 위임 + API 호출                  |

### 설계 결정: 왜 전용 평가 에이전트인가

**Gateway에서 LLM 호출하는 방식은 부적합:**

- Gateway는 오케스트레이션/라우팅 계층 — LLM 판단 로직이 들어가면 역할이 오염됨
- LLM 클라이언트, API 키, 토큰 추적 등 Gateway에 불필요한 의존성 추가

**실행 에이전트가 자체 평가하는 방식도 부적합:**

- 자기 결과물을 자기가 평가하면 편향 발생
- Ouroboros도 이 한계를 가지지만, 단일 프로세스라 어쩔 수 없었음

**전용 평가 에이전트가 최적:**

- 기존 task delegation / A2A 패턴 그대로 사용
- 실행 ≠ 평가 분리로 편향 제거
- Gateway는 오케스트레이션만 수행 (LLM 호출 없음)
- 11개 에이전트 + 1개 평가 에이전트 = 기존 패턴 확장

---

## 2. Phase별 계층 배치

```
                     Task Hub          Gateway           실행 에이전트    평가 에이전트
                   ┌───────────┐   ┌────────────┐     ┌──────────┐    ┌──────────┐
Phase 0 Big Bang   │ ████████  │   │ ██         │     │          │    │ ████████ │
Phase 1 PAL Router │ ██        │   │ ████████   │     │          │    │          │
Phase 2 Double     │ ████      │   │ ████████   │     │ ████████ │    │ ████     │
Phase 3 Resilience │ ██        │   │ ████████   │     │ ██       │    │          │
Phase 4 Evaluation │ ██████    │   │ ████       │     │ ██       │    │ ████████ │
Phase 5 Evolution  │ ████████  │   │ ██████     │     │          │    │ ████████ │
                   └───────────┘   └────────────┘     └──────────┘    └──────────┘
```

---

## 3. 평가 에이전트 (Evaluator Agent)

### 역할

Ouroboros의 9개 페르소나 중 **판단/메타인지 계열**을 전담하는 12번째 에이전트.

| 역할                     | Ouroboros 페르소나   | 수행 Phase      |
| ------------------------ | -------------------- | --------------- |
| 모호성 평가              | Socratic Interviewer | Phase 0         |
| AC 원자성 판단 + 분해    | Ontologist           | Phase 2         |
| 시맨틱 평가              | Evaluator            | Phase 4 Stage 2 |
| 합의 투표 오케스트레이션 | Evaluator            | Phase 4 Stage 3 |
| Wonder 질문 생성         | Ontologist           | Phase 5         |
| Reflect 개선안 도출      | Seed Architect       | Phase 5         |

### 도구

```typescript
// 평가 에이전트가 사용하는 도구
harness_score_ambiguity; // Phase 0: 모호성 점수 계산 결과 제출
harness_submit_decomposition; // Phase 2: AC 분해 결과 제출
harness_evaluate_semantic; // Phase 4: 시맨틱 평가 결과 제출
harness_vote_consensus; // Phase 4: 합의 투표 결과 제출
harness_submit_wonder; // Phase 5: Wonder 질문 제출
harness_submit_reflect; // Phase 5: Reflect 개선안 제출
harness_report_drift; // 공통: 드리프트 측정 결과 제출
```

### 태스크 위임 흐름

```
Gateway 감지                   평가 에이전트 태스크
─────────────                 ────────────────────
Harness 생성 중 (UI 입력)  →  "이 스펙의 모호성 점수를 계산하세요"
AC 분해 필요               →  "이 AC의 원자성을 판단하고 필요시 분해하세요"
실행 에이전트 완료 감지    →  "이 실행 결과를 시맨틱 평가하세요"
평가 실패 + 정체 감지      →  (Gateway가 직접 페르소나 프롬프트 선택 — 규칙 기반)
진화 조건 충족             →  "Wonder/Reflect를 수행하세요"
```

---

## 4. Phase 0: Big Bang — 인터뷰 → Seed 생성

### Ouroboros 원본

- InterviewEngine: 소크라테스식 질문 반복
- AmbiguityScorer: 3-4차원 가중 점수 (Goal 40%, Constraint 30%, Success 30%)
- 게이트: 모호성 ≤ 0.2일 때만 Seed 생성 허용

### 분리 아키텍처 배치

| 계층              | 책임                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| **Task Hub**      | UI 입력 (Goal, Constraints, AC, Steps) + 점수 표시 + Launch 게이트       |
| **Gateway**       | Task Hub → 평가 에이전트 태스크 위임 중개                                |
| **평가 에이전트** | LLM 호출로 모호성 점수 계산 → `harness_score_ambiguity` 도구로 결과 제출 |

### 흐름

```
1. 사용자가 Task Hub UI에서 Harness 스펙 입력
2. Task Hub → POST /api/harness/{id}/request-ambiguity-score
3. Task Hub → Gateway API 호출 (평가 에이전트에 태스크 위임)
4. Gateway → 평가 에이전트에 backlog 태스크 생성:
   "다음 Harness 스펙의 모호성을 평가하세요: {goal, constraints, AC, steps}"
5. 평가 에이전트:
   - 3-4개 차원 평가 (temperature 0.1)
   - harness_score_ambiguity(projectId, { goalClarity, constraintClarity, ... }) 호출
6. 도구가 Task Hub API에 점수 저장
7. Task Hub UI에 점수 실시간 표시
8. ambiguity ≤ 0.2이면 Launch 버튼 활성화
```

### 데이터 모델

```typescript
// Task Hub: IHarnessProject 확장
interface IAmbiguityScore {
  overall: number; // 0.0-1.0 (≤0.2이면 launch 가능)
  breakdown: {
    goalClarity: number; // 0.0-1.0
    constraintClarity: number;
    successCriteriaClarity: number;
    contextClarity?: number; // brownfield일 때만
  };
  weights: {
    // Ouroboros 가중치
    goal: number; // 0.40 (greenfield) / 0.35 (brownfield)
    constraint: number; // 0.30 / 0.25
    success: number; // 0.30 / 0.25
    context?: number; // 0 / 0.15
  };
  isReadyForLaunch: boolean;
  scoredAt: Date;
}

interface IHarnessProject {
  // ... 기존 필드
  ambiguityScore?: IAmbiguityScore;
  isBrownfield: boolean;
  seedFrozenAt?: Date; // Seed 확정 시점 (이후 수정 차단)
}
```

### Launch 게이트

```typescript
// task-hub: launch/route.ts 수정
if (!project.ambiguityScore || project.ambiguityScore.overall > 0.2) {
  return Response.json({ error: "Ambiguity score must be ≤ 0.2 before launch" }, { status: 422 });
}
```

---

## 5. Phase 1: PAL Router — 복잡도 기반 모델 선택

### Ouroboros 원본

- 가중 합산: tokens 30% + tools 30% + AC depth 40%
- < 0.4 → FRUGAL, < 0.7 → STANDARD, ≥ 0.7 → FRONTIER
- 2연속 실패 → 에스컬레이션, 5연속 성공 → 다운그레이드

### 분리 아키텍처 배치

PAL Router는 **LLM 호출이 필요 없는 순수 함수**이므로 Gateway에서 직접 처리.

```typescript
// Gateway: src/services/pal-router.ts (신규)

type ModelTier = "frugal" | "standard" | "frontier";

interface ComplexityScore {
  score: number; // 0.0-1.0
  breakdown: { tokenScore: number; toolScore: number; depthScore: number };
  tier: ModelTier;
}

// Ouroboros 알고리즘 그대로 (순수 함수)
const WEIGHTS = { tokens: 0.3, tools: 0.3, depth: 0.4 };
const THRESHOLDS = { frugal: 0.4, standard: 0.7 };
const NORM = { tokens: 4000, tools: 5, depth: 5 };

function computeComplexity(ctx: {
  estimatedTokens: number;
  toolCount: number;
  acDepth: number;
}): ComplexityScore {
  const tokenScore = Math.min(ctx.estimatedTokens / NORM.tokens, 1.0);
  const toolScore = Math.min(ctx.toolCount / NORM.tools, 1.0);
  const depthScore = Math.min(ctx.acDepth / NORM.depth, 1.0);
  const score =
    WEIGHTS.tokens * tokenScore + WEIGHTS.tools * toolScore + WEIGHTS.depth * depthScore;
  const tier: ModelTier =
    score < THRESHOLDS.frugal ? "frugal" : score < THRESHOLDS.standard ? "standard" : "frontier";
  return { score, breakdown: { tokenScore, toolScore, depthScore }, tier };
}
```

### 에스컬레이션/다운그레이드

```typescript
interface TierState {
  currentTier: ModelTier;
  consecutiveFailures: number; // ≥2 → 상위 티어
  consecutiveSuccesses: number; // ≥5 → 하위 티어
}

// TaskFile에 저장
interface TaskFile {
  // ... 기존 필드
  palTierState?: TierState;
}
```

### 모델 매핑 (config)

```yaml
agents:
  defaults:
    ouroboros:
      palRouter:
        enabled: true
        tierModels:
          frugal: "claude-haiku-4-5-20251001"
          standard: "claude-sonnet-4-6"
          frontier: "claude-opus-4-6"
        escalationThreshold: 2
        downgradeThreshold: 5
```

---

## 6. Phase 2: Double Diamond — AC 분해 + 병렬 실행

### Ouroboros 원본

- AC를 ACTree로 재귀 분해 (원자성 판단 → 2-5개 자식)
- 4단계: Discover → Define → Design → Deliver
- MAX_DEPTH=5, 깊이 3+ 컨텍스트 압축
- 자식 간 의존성 DAG → 병렬 실행

### 분리 아키텍처 배치

| 계층              | 책임                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| **Task Hub**      | AC Tree 저장 + 시각화                                                                        |
| **Gateway**       | AC 분해 태스크를 평가 에이전트에 위임 + 의존성 DAG 스케줄링 + 원자적 AC → 실행 에이전트 위임 |
| **평가 에이전트** | AC 원자성 판단 + 비원자적 AC 분해 (LLM 호출)                                                 |
| **실행 에이전트** | 원자적 AC를 받아 4단계 수행 + harness_report_step으로 보고                                   |

### 흐름

```
1. Launch 시 → Seed의 acceptance_criteria가 AC Tree의 루트 노드
2. Gateway → 평가 에이전트에 "이 AC를 분해하세요" 태스크 위임
3. 평가 에이전트:
   - 원자성 판단 (LLM 호출)
   - 원자적 → harness_submit_decomposition({ atomic: true })
   - 비원자적 → 2-5개 자식 분해 + 의존성 배열 보고
4. Gateway: 분해 결과 → AC Tree 업데이트 → Task Hub 저장
5. 원자적 노드 → 실행 에이전트에 태스크로 위임
6. 의존성 없는 노드끼리 병렬 실행
7. 실행 에이전트: Discover → Define → Design → Deliver
8. 각 step 완료 시 harness_report_step 호출
```

### 데이터 모델

```typescript
type ACStatus = "pending" | "atomic" | "decomposed" | "executing" | "completed" | "failed";

interface ACNode {
  id: string; // "ac_{uuid}"
  content: string;
  depth: number; // 0-5
  parentId: string | null;
  status: ACStatus;
  isAtomic: boolean;
  childrenIds: string[];
  dependsOn: string[]; // 형제 AC의 id 목록
  taskId?: string; // 위임된 TaskFile id
  executionResult?: string;
  complexityScore?: number;
}

interface ACTree {
  rootId: string;
  nodes: Record<string, ACNode>;
  status: "pending" | "decomposing" | "executing" | "completed" | "failed";
}
```

### 실행 에이전트 프롬프트 주입

```typescript
// task-continuation-runner.ts: formatBacklogPickupPrompt 확장

if (task.acNodeId) {
  lines.push(`## Double Diamond Protocol`);
  lines.push(`이 태스크는 AC Tree의 원자적 노드입니다.`);
  lines.push(`**AC:** ${task.acContent}`);
  lines.push(``);
  lines.push(`다음 4단계를 순서대로 수행하세요:`);
  lines.push(`1. **Discover** — 문제 공간을 탐색하고 관련 코드/문서를 파악`);
  lines.push(`2. **Define** — 핵심 문제를 정의하고 범위를 확정`);
  lines.push(`3. **Design** — 해결 방안을 설계`);
  lines.push(`4. **Deliver** — 구현하고 harness_report_step으로 보고`);
}
```

---

## 7. Phase 3: Resilience — 정체 감지 + 측면 사고

### Ouroboros 원본

4가지 정체 패턴:

- **SPINNING**: 같은 출력 반복 (SHA-256 해시, 3회)
- **OSCILLATION**: A→B→A→B 교대 (2주기)
- **NO_DRIFT**: 드리프트 변화 < 0.01 (3회)
- **DIMINISHING_RETURNS**: 개선율 단조 감소 (< 0.01)

5가지 페르소나: Hacker, Researcher, Simplifier, Architect, Contrarian

### 분리 아키텍처 배치

정체 감지는 **해시 비교, 수치 비교** 등 규칙 기반이므로 Gateway에서 직접 처리.
페르소나 선택도 **매핑 테이블** 기반이므로 LLM 불필요.

| 계층              | 책임                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **Gateway**       | 정체 패턴 감지 (규칙 기반) + 페르소나 프롬프트 선택 (매핑 테이블) + 실행 에이전트에 주입 |
| **실행 에이전트** | 페르소나 프롬프트를 받아 다른 접근법으로 재시도                                          |
| **Task Hub**      | 정체 이벤트 기록 + UI 알림                                                               |

### 정체 감지

```typescript
// Gateway: src/services/stagnation-detector.ts (신규)

type StagnationPattern = "spinning" | "oscillation" | "no_drift" | "diminishing_returns";

interface StagnationDetection {
  pattern: StagnationPattern;
  detected: boolean;
  confidence: number;
  evidence: Record<string, unknown>;
}

const THRESHOLDS = {
  spinning: 3,
  oscillationCycles: 2,
  noDriftEpsilon: 0.01,
  noDriftIterations: 3,
  diminishingThreshold: 0.01,
};

// TaskFile에 실행 이력 추가
interface TaskFile {
  // ... 기존 필드
  executionHistory?: {
    outputHashes: string[]; // SHA-256 해시
    driftScores: number[];
    iterationCount: number;
    appliedPersonas: string[];
  };
}
```

### 페르소나 선택 + 프롬프트 주입

```typescript
type ThinkingPersona = "hacker" | "researcher" | "simplifier" | "architect" | "contrarian";

const PERSONA_AFFINITY: Record<StagnationPattern, ThinkingPersona[]> = {
  spinning: ["hacker", "contrarian"],
  oscillation: ["simplifier", "architect", "contrarian"],
  no_drift: ["researcher", "architect", "contrarian"],
  diminishing_returns: ["researcher", "simplifier", "contrarian"],
};

const PERSONA_PROMPTS: Record<ThinkingPersona, string> = {
  hacker: `## HACKER Mode
현재 접근이 반복되고 있습니다. 관점을 전환하세요:
- 당신이 가정하고 있는 제약 중 실제로는 존재하지 않는 것은?
- 장애물을 완전히 우회하는 해킹적 방법이 있는가?
- 10분 안에 해결해야 한다면 어떻게 하겠는가?`,

  researcher: `## RESEARCHER Mode
진행이 멈춰 있습니다. 코딩을 멈추고 조사하세요:
- 실제 증거 vs 가정을 구분하세요
- 유사한 문제와 그 해결책을 검색하세요
- 어떤 정보가 있으면 접근법이 바뀌겠는가?`,

  simplifier: `## SIMPLIFIER Mode
복잡성이 장애물입니다. 단순화하세요:
- 동작할 수 있는 가장 단순한 것은?
- 추가하는 대신 제거할 수 있는 것은?
- 올바른 문제를 풀고 있는가, 아니면 더 어려운 버전을 풀고 있는가?`,

  architect: `## ARCHITECT Mode
구조 자체가 문제일 수 있습니다. 재구성하세요:
- 처음부터 다시 만든다면 같은 구조로 만들겠는가?
- 구조 자체가 문제를 일으키고 있지는 않은가?
- 컴포넌트를 재배치하면 어떻게 달라지는가?`,

  contrarian: `## CONTRARIAN Mode
모든 가정에 도전하세요:
- 현재 접근법의 반대가 옳다면?
- 당연하다고 여기는 것 중 틀린 것은?
- 당신에게 반대하는 사람이라면 뭐라고 하겠는가?`,
};

// task-continuation-runner.ts의 formatContinuationPrompt()에서 주입
// 5가지 모두 소진 시 → 태스크를 blocked로 전환
```

---

## 8. Phase 4: Evaluation — 3단계 검증 파이프라인

### Ouroboros 원본

1. **Mechanical ($0)**: lint, build, test, static, coverage ≥ 70%
2. **Semantic ($$)**: LLM이 AC 준수/goal 정렬/드리프트 평가
3. **Consensus ($$$)**: 3모델 투표 (2/3 과반), 6개 트리거로 진입

### 분리 아키텍처 배치

| Stage                   | 수행 주체         | 이유                                |
| ----------------------- | ----------------- | ----------------------------------- |
| **Stage 1: Mechanical** | 실행 에이전트     | 이미 lint/build/test 도구 사용 가능 |
| **Stage 2: Semantic**   | **평가 에이전트** | 자기 평가 편향 방지                 |
| **Stage 3: Consensus**  | **평가 에이전트** | 멀티모델 투표 오케스트레이션        |

### 흐름

```
1. 실행 에이전트: 코드 작성 → lint/build/test 실행 (Stage 1)
   └→ harness_report_step으로 결과 보고

2. Gateway: 실행 완료 감지 → 평가 태스크 생성
   "실행 에이전트 {id}의 결과물을 Stage 2 평가하세요"
   (태스크에 AC 내용, Seed goal/constraints, 결과물 경로 포함)

3. 평가 에이전트: 결과물 읽고 평가
   - AC 준수 여부
   - Goal 정렬도 (0.0-1.0)
   - Drift 측정 (goal 50% + constraint 30% + ontology 20%)
   - Uncertainty (0.0-1.0)
   └→ harness_evaluate_semantic(itemId, { score, acCompliance, ... })

4. Gateway: 평가 결과 확인 + 트리거 판단 (규칙 기반)
   - score ≥ 0.8 + 트리거 없음 → 통과
   - 트리거 조건 해당 → Stage 3 태스크 생성

5. 평가 에이전트: Stage 3 Consensus (트리거 시만)
   - 3가지 역할: Advocate → Devil's Advocate → Judge
   └→ harness_vote_consensus(itemId, { approved, votes, majorityRatio })
```

### Consensus 트리거 조건 (Ouroboros 6개 그대로)

```
1. Seed modification (freeze된 spec 변경 시도)
2. Ontology evolution (AC 구조 변경)
3. Goal reinterpretation (goalAlignment < 0.6)
4. Drift > 0.3
5. Uncertainty > 0.3
6. Lateral thinking adoption (Phase 3 페르소나 전환 후 결과)
```

트리거 판단은 **수치 비교**이므로 Gateway에서 규칙 기반으로 처리.

### 평가 에이전트 도구

```typescript
// src/agents/tools/evaluation-tool.ts (신규)

// Stage 2 결과 제출
harness_evaluate_semantic: {
  params: {
    item_id: string,
    score: number,           // 0.0-1.0
    ac_compliance: boolean,
    goal_alignment: number,
    drift_score: number,
    uncertainty: number,
    reasoning: string,
  }
}

// Stage 3 합의 결과 제출
harness_vote_consensus: {
  params: {
    item_id: string,
    approved: boolean,
    votes: { role: string, approved: boolean, confidence: number, reasoning: string }[],
    majority_ratio: number,
  }
}

// 드리프트 측정 결과 제출
harness_report_drift: {
  params: {
    item_id: string,
    goal_drift: number,       // weight 50%
    constraint_drift: number, // weight 30%
    ontology_drift: number,   // weight 20%
    combined: number,
  }
}
```

---

## 9. Phase 5: Evolution — 진화 루프

### Ouroboros 원본

- Wonder: "아직 모르는 것은?" → 질문 + 온톨로지 긴장
- Reflect: Seed + 평가 → 개선된 AC + ontology mutation
- 새 Seed 생성 (parent_seed_id로 계보)
- 수렴: ontology similarity ≥ 0.95
- 최대 30세대, 3연속 무변화 시 정체

### 분리 아키텍처 배치

| 계층              | 책임                                                      |
| ----------------- | --------------------------------------------------------- |
| **평가 에이전트** | Wonder 질문 생성 + Reflect 개선안 도출 (LLM 판단)         |
| **Gateway**       | 수렴 판정 (규칙 기반 수학 비교) + 다음 세대 Launch 트리거 |
| **Task Hub**      | 세대 기록 저장 + 계보 시각화 + Evolution 상태 관리        |

### 흐름

```
1. Phase 4 완료 → Gateway가 진화 필요성 판단 (규칙 기반)
   - 평가 실패 (score < 0.8) 또는 수렴 미달 (similarity < 0.95)

2. Gateway → 평가 에이전트에 Wonder 태스크 위임
   "이전 세대의 결과를 보고 아직 모르는 것이 무엇인지 분석하세요"

3. 평가 에이전트:
   - 현재 ontology + 평가 결과 분석
   - 3-5개 질문 + 온톨로지 긴장 식별
   └→ harness_submit_wonder(projectId, { questions, ontologyTensions, shouldContinue })

4. shouldContinue=true → Gateway가 Reflect 태스크 위임

5. 평가 에이전트:
   - 현재 Seed + Wonder 질문 → 개선된 AC + ontology mutation 제안
   └→ harness_submit_reflect(projectId, {
        refinedGoal, refinedConstraints, refinedACs, ontologyMutations })

6. Gateway:
   - Reflect 결과로 새 세대 HarnessItem 생성 (Task Hub API)
   - ontology similarity 계산 (순수 수학 — LLM 불필요)
   - 수렴 확인 → 미수렴이면 다음 세대 Launch

7. Task Hub: 세대 기록 저장 + 계보 업데이트
```

### 수렴 판정 (Gateway — 규칙 기반)

```typescript
// Gateway: src/services/convergence-checker.ts (신규)

// Ouroboros similarity 알고리즘 (순수 수학, LLM 불필요)
function computeOntologySimilarity(
  prev: { name: string; type: string; description: string }[],
  curr: { name: string; type: string; description: string }[],
): number {
  const prevNames = new Set(prev.map((f) => f.name));
  const currNames = new Set(curr.map((f) => f.name));
  const allNames = new Set([...prevNames, ...currNames]);
  if (allNames.size === 0) return 1.0;

  const intersection = [...prevNames].filter((n) => currNames.has(n));

  // Name overlap (50%)
  const nameOverlap = intersection.length / allNames.size;

  // Type match (30%)
  const typeMatches = intersection.filter(
    (name) => prev.find((f) => f.name === name)?.type === curr.find((f) => f.name === name)?.type,
  );
  const typeMatch = intersection.length > 0 ? typeMatches.length / intersection.length : 1.0;

  // Exact match (20%)
  const exactMatches = intersection.filter((name) => {
    const p = prev.find((f) => f.name === name);
    const c = curr.find((f) => f.name === name);
    return p?.type === c?.type && p?.description === c?.description;
  });
  const exactMatch = intersection.length > 0 ? exactMatches.length / intersection.length : 1.0;

  return 0.5 * nameOverlap + 0.3 * typeMatch + 0.2 * exactMatch;
}

const CONVERGENCE_THRESHOLD = 0.95;
const MAX_GENERATIONS = 30;
const STAGNATION_WINDOW = 3;
```

### 데이터 모델

```typescript
// Task Hub

interface IGenerationRecord {
  generationNumber: number;
  seedId: string;
  parentSeedId?: string;
  ontologySnapshot: { fields: { name: string; type: string; description: string }[] };
  evaluationSummary?: {
    finalApproved: boolean;
    score: number;
    driftScore: number;
    acResults: { content: string; passed: boolean }[];
  };
  wonderQuestions: string[];
  reflectMutations?: { action: string; fieldName: string; reason: string }[];
  status: "pending" | "executing" | "completed" | "failed";
  createdAt: Date;
}

interface IEvolutionState {
  lineageId: string;
  currentGeneration: number;
  maxGenerations: number; // 30
  status: "active" | "converged" | "exhausted" | "stagnated";
  generations: IGenerationRecord[];
  convergenceHistory: { generation: number; similarity: number }[];
}
```

---

## 10. 전체 데이터 흐름

```
Task Hub                    Gateway (오케스트레이션)          실행 에이전트          평가 에이전트
────────                    ─────────────────────           ──────────────         ──────────────

[Phase 0]
UI 입력 ──────────────────▶ 평가 태스크 위임 ───────────────────────────────────▶ 모호성 점수 계산
점수 표시 ◀── API ◀─────── 결과 라우팅 ◀──── harness_score_ambiguity ───────────┘
Launch 게이트 (≤0.2)

[Phase 1]
복잡도 저장 ◀──────────────computeComplexity()
                            (순수 함수, 에이전트 불필요)

[Phase 2]
                            AC 분해 태스크 위임 ────────────────────────────────▶ 원자성 판단+분해
AC Tree 저장 ◀── API ◀──── 분해 결과 반영 ◀───── harness_submit_decomposition ─┘
                            원자적 AC → 태스크 위임 ──────▶ Discover→Define
                                                             →Design→Deliver
                            ◀── harness_report_step ──────────┘

[Phase 3]
정체 이벤트 ◀──────────────정체 감지 (규칙 기반)
                            페르소나 프롬프트 선택
                            continuation prompt 주입 ──────▶ 페르소나 모드로
                                                             재시도

[Phase 4]
Stage1 결과 ◀── API ◀──── 실행 완료 감지 ◀── report ──────── lint/build/test
                            평가 태스크 위임 ───────────────────────────────────▶ Stage 2 Semantic
Stage2 결과 ◀── API ◀──── 결과 라우팅 ◀──── harness_evaluate_semantic ──────────┘
                            트리거 판단 (규칙 기반)
                            합의 태스크 위임 (조건부) ──────────────────────────▶ Stage 3 Consensus
투표 기록 ◀── API ◀─────── 결과 라우팅 ◀──── harness_vote_consensus ────────────┘

[Phase 5]
                            진화 필요성 판단 (규칙 기반)
                            Wonder 태스크 위임 ────────────────────────────────▶ Wonder 질문 생성
                            ◀── harness_submit_wonder ─────────────────────────┘
                            Reflect 태스크 위임 ───────────────────────────────▶ Reflect 개선안
                            ◀── harness_submit_reflect ────────────────────────┘
세대 기록 ◀── API ◀─────── 수렴 판정 (규칙 기반)
계보 업데이트                다음 세대 Launch (미수렴 시)
```

---

## 11. 역할 분리 원칙

### Gateway: 오케스트레이션만 (LLM 호출 없음)

| 수행                                 | 비수행              |
| ------------------------------------ | ------------------- |
| 태스크 위임/라우팅                   | LLM 호출            |
| 정체 감지 (규칙 기반 해시/수치 비교) | 시맨틱 평가         |
| 수렴 판정 (수학적 similarity)        | Wonder/Reflect 생성 |
| PAL Router (순수 함수)               | 모호성 점수 계산    |
| 페르소나 프롬프트 선택 (매핑 테이블) | 합의 투표           |
| Consensus 트리거 판단 (수치 비교)    | AC 원자성 판단      |

### 평가 에이전트: LLM 판단 전담

| 수행                            | 비수행                 |
| ------------------------------- | ---------------------- |
| 모호성 점수 계산 (Phase 0)      | 코드 작성              |
| AC 원자성 판단 + 분해 (Phase 2) | 실행 (Phase 2 Deliver) |
| 시맨틱 평가 (Phase 4)           | 인프라 조작            |
| Consensus 투표 (Phase 4)        | 태스크 스케줄링        |
| Wonder/Reflect (Phase 5)        |                        |

### 실행 에이전트: 실행 + Stage 1 검증

| 수행                              | 비수행                       |
| --------------------------------- | ---------------------------- |
| Double Diamond 4단계 (Phase 2)    | 자기 평가 (Phase 4 Stage 2+) |
| lint/build/test (Phase 4 Stage 1) | AC 분해 판단                 |
| 페르소나 모드 재시도 (Phase 3)    | Wonder/Reflect               |
| harness_report_step/check 보고    | 수렴 판정                    |

---

## 12. 구현 파일 목록

### Task Hub (Next.js) — 8개 파일

| #   | 파일                                                | 변경 유형 | 설명                                          |
| --- | --------------------------------------------------- | --------- | --------------------------------------------- |
| 1   | `src/models/Harness.ts`                             | 수정      | IAmbiguityScore, IEvolutionState, ACTree 타입 |
| 2   | `src/app/api/harness/[id]/score-ambiguity/route.ts` | **신규**  | 모호성 점수 저장                              |
| 3   | `src/app/api/harness/[id]/freeze-seed/route.ts`     | **신규**  | Seed 확정                                     |
| 4   | `src/app/api/harness/[id]/evaluate/route.ts`        | **신규**  | Semantic 평가 결과 저장                       |
| 5   | `src/app/api/harness/[id]/consensus/route.ts`       | **신규**  | Consensus 투표 저장                           |
| 6   | `src/app/api/harness/[id]/evolution/route.ts`       | **신규**  | Wonder/Reflect/세대 관리                      |
| 7   | `src/app/api/harness/[id]/drift/route.ts`           | **신규**  | 드리프트 측정 저장                            |
| 8   | `src/app/api/harness/[id]/launch/route.ts`          | 수정      | ambiguity 게이트                              |

### Gateway — 신규 서비스 5개 (LLM 호출 없음)

| #   | 파일                                     | 설명                                |
| --- | ---------------------------------------- | ----------------------------------- |
| 1   | `src/services/pal-router.ts`             | 복잡도 계산 + 티어 선택 (순수 함수) |
| 2   | `src/services/stagnation-detector.ts`    | 4패턴 정체 감지 (규칙 기반)         |
| 3   | `src/services/convergence-checker.ts`    | 수렴 판정 (규칙 기반 수학)          |
| 4   | `src/services/ac-tree.ts`                | ACTree/ACNode 타입 + 유틸           |
| 5   | `src/services/evolution-orchestrator.ts` | 진화 루프 총괄 (태스크 위임 조율)   |

### Gateway — 신규 도구 2개

| #   | 파일                                        | 설명                          |
| --- | ------------------------------------------- | ----------------------------- |
| 6   | `src/agents/tools/evaluation-tool.ts`       | 평가 에이전트 전용 도구 (7개) |
| 7   | `src/agents/tools/ac-decomposition-tool.ts` | AC 분해 결과 보고 도구        |

### Gateway — 기존 파일 수정 5개

| #   | 파일                                    | 설명                                       |
| --- | --------------------------------------- | ------------------------------------------ |
| 8   | `src/agents/tools/task-file-io.ts`      | palTierState, acNodeId, executionHistory   |
| 9   | `src/agents/tools/task-blocking.ts`     | ac_node_id, pal_tier                       |
| 10  | `src/agents/openclaw-tools.ts`          | 도구 등록                                  |
| 11  | `src/infra/task-continuation-runner.ts` | Double Diamond + 정체 감지 + 페르소나 주입 |
| 12  | `src/config/types.agent-defaults.ts`    | OuroborosConfig                            |

### prontoclaw-config — 2개

| #   | 파일                                     | 설명                     |
| --- | ---------------------------------------- | ------------------------ |
| 13  | `workspace-shared/OUROBOROS-PROTOCOL.md` | 실행 에이전트용 프로토콜 |
| 14  | `workspace-evaluator/AGENTS.md`          | 평가 에이전트 설정       |

---

## 13. 설정 스키마

```yaml
# openclaw.json

agents:
  defaults:
    ouroboros:
      enabled: true

      # Phase 0
      ambiguity:
        threshold: 0.2
        weights: { goal: 0.40, constraint: 0.30, success: 0.30, context: 0.15 }

      # Phase 1
      palRouter:
        enabled: true
        tierModels:
          frugal: "claude-haiku-4-5-20251001"
          standard: "claude-sonnet-4-6"
          frontier: "claude-opus-4-6"
        escalationThreshold: 2
        downgradeThreshold: 5

      # Phase 2
      doubleDiamond:
        maxDepth: 5
        minChildren: 2
        maxChildren: 5

      # Phase 3
      resilience:
        spinningThreshold: 3
        oscillationCycles: 2
        noDriftEpsilon: 0.01
        diminishingThreshold: 0.01

      # Phase 4
      evaluation:
        semanticPassScore: 0.8
        driftThreshold: 0.3
        uncertaintyThreshold: 0.3
        majorityRatio: 0.67

      # Phase 5
      evolution:
        maxGenerations: 30
        convergenceThreshold: 0.95
        stagnationWindow: 3

      # 평가 에이전트
      evaluatorAgent:
        agentId: "evaluator"
        model: "claude-sonnet-4-6"
```

---

## 14. 구현 순서

```
Phase 1: 기반 인프라 (병렬 가능)
  ├── [Gateway] pal-router.ts (순수 함수)
  ├── [Gateway] stagnation-detector.ts (규칙 기반)
  ├── [Gateway] convergence-checker.ts (규칙 기반)
  └── [Gateway] ac-tree.ts (타입 + 유틸)
       │
Phase 2: 평가 에이전트 + 도구
  ├── [Gateway] evaluation-tool.ts (7개 도구)
  ├── [Gateway] ac-decomposition-tool.ts
  ├── [Gateway] openclaw-tools.ts 등록
  ├── [Config] workspace-evaluator/ 생성
  └── [Task Hub] 7개 신규 API 라우트
       │
Phase 3: 통합
  ├── [Gateway] task-continuation-runner.ts 확장
  ├── [Gateway] evolution-orchestrator.ts
  ├── [Gateway] TaskFile 확장
  ├── [Task Hub] launch/route.ts 수정
  └── [Config] OUROBOROS-PROTOCOL.md
```

---

_작성일: 2026-03-03_
