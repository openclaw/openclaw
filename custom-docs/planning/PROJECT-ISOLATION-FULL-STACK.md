# 프로젝트별 격리 — 풀스택 설계

> 작성일: 2026-03-07
> 참고: Paperclip의 company-scoped isolation 패턴

## 목표

같은 에이전트 팀(루다, 이든, 세움, 윤슬 등)을 유지하면서 여러 창업 프로젝트(레소나, 유리프트, 에스랩 등)를 **컨텍스트 분리**하여 운영한다.

에이전트가 "레소나 작업"을 할 때는 레소나의 목표·제약·결정사항·코드베이스만 보고,
"유리프트 작업"을 할 때는 유리프트 컨텍스트만 보게 한다.

---

## 현재 구조 (문제점)

```
prontoclaw gateway
├── openclaw.json (에이전트 11개, 프로젝트 개념 없음)
├── workspace-ruda/
│   └── tasks/
│       ├── task_abc.md  ← 레소나 작업
│       ├── task_def.md  ← 유리프트 작업  ← 섞여 있음
│       └── task_ghi.md  ← 에스랩 작업
├── workspace-eden/
│   └── tasks/ ...
└── ...

task-hub (MongoDB)
├── HarnessProject  ← 프로젝트 구분 없음 (flat)
├── Milestone       ← flat
└── Todo            ← category 문자열로만 구분
```

**문제:**

1. 에이전트의 태스크 목록에 모든 프로젝트 작업이 섞여 있음
2. 태스크 시작 시 "이 작업이 어떤 프로젝트인지" 컨텍스트가 명시적이지 않음
3. Harness/Milestone이 프로젝트에 소속되지 않음
4. 에이전트가 프로젝트 A 작업 중 프로젝트 B의 정보를 참조할 수 있음 (격리 없음)

---

## Paperclip에서 배울 점

Paperclip의 핵심 격리 패턴:

| 패턴                   | Paperclip 구현                                        | 우리에게 적용                                      |
| ---------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **Company 스코핑**     | 모든 테이블에 `company_id` FK, 모든 쿼리에 where 조건 | 모든 엔티티에 `projectSlug` 필드                   |
| **에이전트-회사 소속** | `agents.company_id` — 에이전트는 하나의 회사에 소속   | 에이전트는 **여러 프로젝트에 소속 가능** (1:N)     |
| **Goal 계층**          | company → goals → projects → issues                   | project → harness/milestone → tasks                |
| **컨텍스트 주입**      | 에이전트 실행 시 회사 미션/목표를 프롬프트에 주입     | 태스크 시작 시 프로젝트 컨텍스트를 프롬프트에 주입 |
| **비용 격리**          | `cost_events.company_id`로 회사별 비용 집계           | (후속) 프로젝트별 토큰 사용량 집계                 |

**Paperclip과 다른 점:**

- Paperclip: 에이전트 = 1개 회사 (고정 소속)
- 우리: 에이전트 = N개 프로젝트 (유동 할당) ← 같은 팀이 여러 프로젝트를 돌리니까

---

## 설계

### 1. 프로젝트 정의 (Configuration Layer)

#### 1-1. openclaw.json에 projects 섹션 추가

```jsonc
// openclaw.json
{
  "agents": {
    "list": [
      { "id": "ruda", "name": "루다", ... },
      { "id": "eden", "name": "이든", ... },
      ...
    ],

    // NEW: 프로젝트 정의
    "projects": [
      {
        "slug": "resonar",
        "name": "레소나",
        "description": "음악 스트리밍 서비스",
        "repoPath": "/path/to/resonar",
        "agents": ["ruda", "eden", "yunseul"],
        "contextFile": "PROJECT-CONTEXT.md"  // 프로젝트별 컨텍스트 파일
      },
      {
        "slug": "ulift",
        "name": "유리프트",
        "description": "피트니스 플랫폼",
        "repoPath": "/path/to/ulift",
        "agents": ["eden", "seum"],
        "contextFile": "PROJECT-CONTEXT.md"
      },
      {
        "slug": "slab",
        "name": "에스랩",
        "description": "연구 실험 플랫폼",
        "agents": ["yunseul", "ieum"],
        "contextFile": "PROJECT-CONTEXT.md"
      }
    ]
  }
}
```

#### 1-2. 프로젝트 컨텍스트 파일

각 프로젝트 저장소(또는 별도 경로)에 `PROJECT-CONTEXT.md` 파일을 둔다.
에이전트가 해당 프로젝트 태스크를 시작할 때 이 파일이 프롬프트에 주입된다.

```markdown
# 레소나 (Resonar)

## 미션

음악 스트리밍의 새로운 경험을 만든다.

## 현재 단계

MVP 개발 중. 핵심 기능: 플레이리스트 생성, 추천 알고리즘, 소셜 공유.

## 기술 스택

- Frontend: Next.js 15, TypeScript, Tailwind
- Backend: Node.js, PostgreSQL, Redis
- Infra: Vercel, Supabase

## 핵심 제약

- 저작권 이슈로 음원 직접 호스팅 불가 → 외부 API 연동
- MVP는 웹만 (모바일 후순위)

## 최근 결정사항

- 2026-03-01: 추천 알고리즘은 collaborative filtering 우선
- 2026-02-28: 인증은 Supabase Auth 사용

## 디렉토리 구조

src/
├── app/ # Next.js pages
├── lib/ # 공통 유틸
├── components/ # UI 컴포넌트
└── server/ # API routes
```

이 패턴은 Paperclip의 "Company mission → Goal alignment" 개념을 파일 기반으로 구현한 것.

---

### 2. 태스크 레이어 (prontoclaw)

#### 2-1. TaskFile에 projectSlug 필드 추가

```typescript
// task-file-io.ts — TaskFile interface 확장
interface TaskFile {
  // ... 기존 필드 ...

  // NEW: 프로젝트 소속
  projectSlug?: string; // "resonar", "ulift", "slab", null(개인)
}
```

마크다운 태스크 파일의 Backlog 섹션:

```markdown
## Backlog

{
"id": "task_abc123",
"status": "backlog",
"projectSlug": "resonar",
"description": "추천 알고리즘 API 엔드포인트 구현",
"harnessProjectSlug": "resonar-mvp",
...
}
```

#### 2-2. 태스크 도구에 프로젝트 컨텍스트 주입

```typescript
// task-blocking.ts 또는 openclaw-tools.ts

// task_start, task_pick_backlog 실행 시:
function injectProjectContext(task: TaskFile, config: AgentConfig): string {
  if (!task.projectSlug) return "";

  const project = config.projects.find((p) => p.slug === task.projectSlug);
  if (!project) return "";

  // 프로젝트 컨텍스트 파일 읽기
  const contextPath = path.join(project.repoPath, project.contextFile);
  const context = fs.readFileSync(contextPath, "utf-8");

  return `\n\n---\n## 프로젝트 컨텍스트: ${project.name}\n${context}\n---\n`;
}
```

**에이전트가 태스크를 시작할 때:**

1. `task_pick_backlog` 또는 `task_start` 호출
2. `projectSlug`가 있으면 해당 프로젝트의 `PROJECT-CONTEXT.md`를 읽어서 continuation message에 포함
3. 에이전트는 해당 프로젝트의 목표·기술스택·제약·결정사항을 알고 작업 시작

#### 2-3. Backlog 필터링 (프로젝트 기반)

```typescript
// task_list, task_pick_backlog에 프로젝트 필터 추가

// 에이전트가 "레소나 작업만 보여줘"라고 하면:
task_list({ projectSlug: "resonar" });

// continuation runner가 backlog에서 태스크를 고를 때:
// 에이전트의 소속 프로젝트에 해당하는 태스크만 선택
function pickNextBacklogTask(agentId: string, config: AgentConfig): TaskFile | null {
  const agentProjects = config.projects
    .filter((p) => p.agents.includes(agentId))
    .map((p) => p.slug);

  const backlogTasks = listBacklogTasks(agentId);
  return backlogTasks.find((t) => !t.projectSlug || agentProjects.includes(t.projectSlug));
}
```

#### 2-4. 크로스 프로젝트 태스크 할당 검증 (선택적)

```typescript
// task_backlog_add에서 프로젝트 멤버십 검증
function validateCrossProjectAssignment(
  sourceAgent: string,
  targetAgent: string,
  projectSlug: string,
  config: AgentConfig,
): boolean {
  if (!projectSlug) return true; // 프로젝트 없는 태스크는 자유롭게

  const project = config.projects.find((p) => p.slug === projectSlug);
  if (!project) return true;

  // 대상 에이전트가 해당 프로젝트 멤버인지 확인
  return project.agents.includes(targetAgent);
}
```

> **Paperclip 대비:** Paperclip은 company 경계를 넘는 할당을 완전히 차단한다.
> 우리는 **경고 후 허용** (soft boundary) — 같은 팀이니까 유연하게.

---

### 3. Gateway 레이어

#### 3-1. 태스크 생성 시 projectSlug 전달

```typescript
// gateway.ts — delegateToAgent 확장

interface DelegateOptions {
  agentId: string;
  description: string;
  priority: string;
  // NEW
  projectSlug?: string;
  // 기존
  harnessProjectSlug?: string;
  harnessItemId?: string;
  milestoneId?: string;
}

// task_backlog_add 호출 시 projectSlug 포함
await callAgentTool(agentId, "task_backlog_add", {
  description,
  priority,
  projectSlug, // NEW
  harnessProjectSlug,
  harnessItemId,
});
```

#### 3-2. Continuation Runner — 프로젝트 컨텍스트 주입

```typescript
// task-continuation-runner.ts

// 태스크 연속 실행 시, 프로젝트 컨텍스트를 메시지에 포함
function buildContinuationMessage(task: TaskFile, config: AgentConfig): string {
  let message = `다음 태스크를 시작합니다: ${task.description}`;

  if (task.projectSlug) {
    const project = config.projects.find((p) => p.slug === task.projectSlug);
    if (project) {
      const contextContent = readProjectContext(project);
      message += `\n\n[프로젝트: ${project.name}]\n${contextContent}`;
    }
  }

  return message;
}
```

---

### 4. Task Hub 레이어 (MongoDB + UI)

#### 4-1. Project 모델

(기존 `2026-03-06-project-isolation-dashboard.md` 설계와 동일)

```typescript
// task-hub/src/models/Project.ts
{
  slug: string,
  name: string,
  description?: string,
  color: string,
  icon?: string,
  status: 'active' | 'paused' | 'archived',
  agents: [{ agentId: string, role?: string }],
  repoPath?: string,
  contextFilePath?: string,  // PROJECT-CONTEXT.md 경로
  links?: [{ label: string, url: string }],
}
```

#### 4-2. 기존 모델 확장

```typescript
// HarnessProject에 projectSlug 추가
HarnessProject.schema.add({ projectSlug: String });

// Milestone에 projectSlug 추가
Milestone.schema.add({ projectSlug: String });

// Todo — category를 projectSlug로 마이그레이션
```

#### 4-3. API 필터링

모든 목록 API에 `?projectSlug=xxx` 파라미터:

```
GET /api/harness?projectSlug=resonar
GET /api/milestones?projectSlug=resonar
GET /api/todos?projectSlug=resonar
GET /api/tasks?projectSlug=resonar     ← prontoclaw 태스크도 필터
```

#### 4-4. 대시보드 UI

프로젝트 목록 (`/projects`) → 프로젝트 대시보드 (`/projects/[slug]`)
(기존 설계안 참조)

---

### 5. 데이터 흐름 (End-to-End)

#### 시나리오: "레소나 추천 알고리즘 구현"

```
1. [Task Hub UI]
   사용자가 Harness "레소나 MVP" 프로젝트에서 "추천 알고리즘 API" 아이템을 Launch
   → projectSlug: "resonar" 설정됨

2. [Task Hub API → Gateway]
   POST /api/harness/{itemId}/launch
   → delegateToAgent("eden", {
       description: "추천 알고리즘 API 엔드포인트 구현",
       projectSlug: "resonar",
       harnessProjectSlug: "resonar-mvp",
       harnessItemId: "..."
     })

3. [Gateway → prontoclaw]
   task_backlog_add 호출
   → eden의 workspace에 태스크 생성:
     task_xyz.md { projectSlug: "resonar", ... }

4. [Continuation Runner]
   eden이 idle 상태가 되면 backlog에서 task_xyz를 pick
   → PROJECT-CONTEXT.md를 읽어서 continuation message에 포함:
     "프로젝트: 레소나 / 기술스택: Next.js, Supabase / 제약: ..."

5. [에이전트 실행]
   eden이 레소나 컨텍스트를 인지한 상태로 작업 수행
   → 레소나 repo에서 코드 수정
   → harness_report_step / harness_report_check 호출

6. [Task Hub 대시보드]
   /projects/resonar 대시보드에서:
   - 하네스 진행률 확인
   - eden의 태스크 상태 확인
   - 최근 활동 피드
```

#### 시나리오: "eden이 레소나 → 유리프트 전환"

```
1. eden이 레소나 task_xyz 완료 → task_complete

2. Continuation runner가 eden의 backlog 확인
   → 다음 태스크: task_abc (projectSlug: "ulift")

3. Continuation message에 유리프트 PROJECT-CONTEXT.md 주입
   → "프로젝트: 유리프트 / 기술스택: React Native, Firebase / ..."

4. eden이 유리프트 컨텍스트로 전환되어 작업 시작
   → 이전 레소나 컨텍스트는 자연스럽게 범위 밖으로
```

이것이 Paperclip의 "company switch" 개념을 우리 방식으로 구현한 것.
Paperclip은 에이전트가 한 회사에 고정이지만, 우리는 **태스크 단위로 프로젝트 컨텍스트가 전환**된다.

---

### 6. 프로젝트 컨텍스트 관리 전략

#### 6-1. 컨텍스트 파일 위치

```
Option A: 프로젝트 레포 안 (추천)
/path/to/resonar/PROJECT-CONTEXT.md
→ 장점: 프로젝트와 함께 버전 관리, 개발자가 직접 수정
→ 단점: 에이전트가 접근 가능해야 함

Option B: 중앙 관리
~/.openclaw/projects/resonar/context.md
→ 장점: 일관된 위치
→ 단점: 레포와 분리되어 동기화 필요

Option C: Task Hub DB에 저장
Project 모델의 context 필드
→ 장점: UI에서 편집 가능
→ 단점: 긴 마크다운을 DB에 저장하는 것은 비효율적
```

**추천: Option A + B 혼합**

- `repoPath`가 있으면 레포 안의 컨텍스트 파일 사용
- 없으면 중앙 경로에서 읽기
- Task Hub UI에서 컨텍스트 파일 내용 미리보기 + 편집 링크 제공

#### 6-2. 컨텍스트 갱신

프로젝트 컨텍스트는 **살아있는 문서**. 에이전트가 중요한 결정을 내리면 자동 갱신하게 할 수 있다:

```typescript
// 에이전트 도구 추가 (선택적)
project_update_context({
  projectSlug: "resonar",
  section: "최근 결정사항",
  append: "2026-03-07: Redis 대신 Upstash KV 사용 결정 (서버리스 호환)",
});
```

---

### 7. 수정 범위 요약

#### prontoclaw (gateway)

| 파일                                    | 변경                                                      | 영향도 |
| --------------------------------------- | --------------------------------------------------------- | ------ |
| `openclaw.json` (config)                | `projects` 섹션 추가                                      | 소     |
| `src/infra/task-file-io.ts`             | `TaskFile`에 `projectSlug` 필드 추가                      | 소     |
| `src/infra/task-continuation-runner.ts` | 프로젝트 컨텍스트 주입 로직                               | 중     |
| `src/agent/openclaw-tools.ts`           | `task_start`, `task_backlog_add`에 `projectSlug` 파라미터 | 소     |
| `src/agent/task-blocking.ts`            | backlog 필터링에 프로젝트 조건 추가                       | 소     |
| `src/infra/agent-scope.ts`              | `resolveAgentProjects()` 유틸 추가                        | 소     |

#### task-hub

| 파일                                 | 변경                                 | 영향도 |
| ------------------------------------ | ------------------------------------ | ------ |
| `src/models/Project.ts`              | 신규 모델                            | 신규   |
| `src/models/Harness.ts`              | `+ projectSlug`                      | 소     |
| `src/models/Milestone.ts`            | `+ projectSlug`                      | 소     |
| `src/models/Todo.ts`                 | `+ projectSlug`, category deprecated | 소     |
| `src/app/api/projects/`              | CRUD + Dashboard API                 | 신규   |
| `src/app/projects/`                  | 목록 + 대시보드 UI                   | 신규   |
| `src/components/ProjectSelector.tsx` | 공통 필터 컴포넌트                   | 신규   |
| 기존 API routes                      | `?projectSlug` 필터 추가             | 소     |
| 기존 페이지들                        | 프로젝트 필터 드롭다운 추가          | 소     |

---

### 8. 구현 순서

```
Phase 1 (Day 1-2): 데이터 기반
├── openclaw.json에 projects 섹션 정의
├── TaskFile에 projectSlug 필드 추가
├── task-hub Project 모델 + CRUD API
├── 기존 모델에 projectSlug 필드 추가
└── 마이그레이션 스크립트 (Todo category → projectSlug)

Phase 2 (Day 3-4): 컨텍스트 주입
├── PROJECT-CONTEXT.md 파일 작성 (각 프로젝트)
├── continuation runner에 프로젝트 컨텍스트 주입
├── task_backlog_add에 projectSlug 전달
└── Harness launch 시 projectSlug 설정

Phase 3 (Day 5-6): UI
├── /projects 목록 페이지
├── /projects/[slug] 대시보드
├── ProjectSelector 공통 컴포넌트
├── 기존 페이지에 프로젝트 필터 추가
└── 사이드바 네비게이션 변경

Phase 4 (Day 7): 검증 + 배포
├── 빌드 확인
├── 기존 기능 회귀 테스트
├── 프로젝트 컨텍스트 전환 테스트
└── 배포
```

---

### 9. Paperclip 대비 우리만의 차별점

| 측면                   | Paperclip                        | 우리 (prontoclaw)                              |
| ---------------------- | -------------------------------- | ---------------------------------------------- |
| 에이전트-프로젝트 관계 | 1:1 (고정 소속)                  | **N:M** (한 에이전트가 여러 프로젝트)          |
| 컨텍스트 전환          | 불가 (다른 회사 = 다른 에이전트) | **태스크 단위로 자동 전환**                    |
| 격리 강도              | Hard (DB 레벨 완전 격리)         | **Soft** (메타데이터 기반, 필요시 크로스 가능) |
| 프로젝트 컨텍스트      | DB에 mission/goal 저장           | **파일 기반** (PROJECT-CONTEXT.md)             |
| 실행 모델              | Paperclip이 직접 에이전트 invoke | Gateway가 실행, Task Hub는 관찰                |

---

### 10. 후속 확장

| 기능                        | 설명                                                  | 시기    |
| --------------------------- | ----------------------------------------------------- | ------- |
| 프로젝트별 비용 집계        | gateway 이벤트에서 토큰 사용량을 projectSlug별로 집계 | Phase 2 |
| 프로젝트별 에이전트 역할    | "레소나에서 루다는 lead, 이든은 developer"            | Phase 2 |
| 프로젝트 컨텍스트 자동 갱신 | 에이전트가 결정사항을 자동으로 context 파일에 추가    | Phase 2 |
| Paperclip 연동              | Paperclip을 상위 레이어로 배포, API 연동              | Phase 3 |
