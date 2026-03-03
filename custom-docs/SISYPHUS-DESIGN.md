# Sisyphus 패턴 Sub-Agent Orchestration 설계

> prontolab-openclaw 11개 Discord AI 에이전트에 oh-my-opencode Sisyphus 스타일 sub-agent orchestration 적용
>
> 관련 문서: [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) | [REFERENCES.md](./REFERENCES.md)
>
> **상태**: 구현 완료

---

## 1. 배경

### 1.1 프로젝트

prontolab-openclaw는 [openclaw/openclaw](https://github.com/openclaw/openclaw) 오픈소스를 포크하여 커스터마이징한 Discord AI 에이전트 플랫폼이다. Mac Mini 서버에서 11개 에이전트가 Discord 봇으로 동작하며, 각 에이전트는 고유한 역할(팀리더, 개발, 인프라, QA, 마케팅 등)을 수행한다.

### 1.2 목표

[oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)의 **Sisyphus 패턴**을 prontolab-openclaw 에이전트에 적용한다.

Sisyphus 패턴의 핵심:

- **부모 에이전트 = Orchestrator**: 유저 대화, 작업 분해, 위임 판단, 결과 검증
- **Sub-agent = 전문 작업자**: 자기만의 전문성(AGENTS.md)을 갖고 특정 작업에만 집중
- **도구 = 손과 눈**: 부모가 직접 실행하는 원자적 작업 (read, write, edit, exec)
- **에이전트 = 다른 사람**: 목표만 주면 스스로 생각하고 도구를 조합하여 실행

### 1.3 제약 조건

- **코드 수정 최소화**: Config(openclaw.json) + Workspace 파일(AGENTS.md) 우선
- **프로덕션 서버에 바로 적용**: 테스트 환경 없음, 안전한 변경만
- **Cross-agent delegation 제외**: 에이전트 간 호출은 이번 범위 밖
- **Haiku 미사용**: 서브에이전트 모델: openai-codex/gpt-5.3-codex 통일

---

## 2. 현재 아키텍처 (As-Is)

### 2.1 에이전트 목록

| ID       | 이름 | 역할          | 모델       | AGENTS.md 크기 |
| -------- | ---- | ------------- | ---------- | -------------- |
| ruda     | 루다 | 팀 리더       | opus-4-6   | 21,458 bytes   |
| eden     | 이든 | 개발          | opus-4-5   | 23,886 bytes   |
| seum     | 세움 | 인프라        | opus-4-5   | 18,182 bytes   |
| dajim    | 다짐 | QA            | opus-4-5   | 14,320 bytes   |
| yunseul  | 윤슬 | 마케팅        | sonnet-4-5 | 17,140 bytes   |
| miri     | 미리 | 비즈니스 분석 | sonnet-4-5 | 16,762 bytes   |
| onsae    | 온새 | 개인비서      | sonnet-4-5 | 18,256 bytes   |
| ieum     | 이음 | 소셜 커뮤니티 | sonnet-4-5 | 8,016 bytes    |
| nuri     | 누리 | CS/커뮤니티   | sonnet-4-5 | 7,567 bytes    |
| hangyeol | 한결 | 법무          | sonnet-4-5 | 9,793 bytes    |
| grim     | 그림 | UI/UX         | sonnet-4-5 | 6,733 bytes    |

### 2.2 현재 Sub-Agent 라이프사이클

```
유저 → Discord 메시지
         │
         ▼
부모 에이전트 (ruda, eden, ...)
         │
         ├─ sessions_spawn(task, model, label, runTimeoutSeconds, cleanup)
         │   ※ agentId 미지정 → 부모 자신의 agentId 사용
         │
         ▼
Sub-Agent Run
         │
         ├─ workspace = 부모와 동일한 workspace 디렉토리
         ├─ promptMode = "minimal"
         ├─ bootstrapFiles = 부모와 동일 (AGENTS.md, SOUL.md 등)
         ├─ tools = 부모와 동일 → DEFAULT_SUBAGENT_TOOL_DENY로 필터링
         │
         ▼
작업 실행 → Announce → 부모에게 결과 전달
```

### 2.3 Sub-Agent가 받는 프롬프트 (3계층)

1. **하드코딩 시스템 프롬프트** (system-prompt.ts, promptMode="minimal") — 도구 목록, Task Tracking 강제, Safety
2. **Extra System Prompt** (buildSubagentSystemPrompt(), ~20줄 고정) — Subagent Context, Rules
3. **Bootstrap Files** (부모와 동일 workspace) — **부모의 전체 AGENTS.md** (최대 20,000 chars)

---

## 3. 문제점

### 3.1 Task 도구 충돌 (Critical)

Sub-agent에게 task 도구가 허용되어 있어서:

- Sub-agent가 `task_start` → 부모의 `workspace/tasks/` 폴더에 task 파일 생성
- 부모의 task 상태를 변경/취소할 수 있음
- 부모의 `task_list`에 sub-agent가 만든 task가 혼재

**해결**: `tools.subagents.tools.deny`에 모든 task/milestone 도구 추가

### 3.2 AGENTS.md 과잉 주입 (High)

Sub-agent는 단순 작업 실행자인데 부모의 전체 AGENTS.md (7K~24K chars)를 받음:

- Task Management 튜토리얼 ~4,230 bytes (이미 차단될 도구 설명)
- Self-Improvement ~2,500 bytes (sub-agent에 불필요)
- Heartbeats ~1,200 bytes, Daily Compaction ~962 bytes (불필요)

Orchestration 패턴을 AGENTS.md에 추가하면 sub-agent도 orchestration 지침을 받게 되어 혼란 발생 가능.

**해결**: Sub-agent를 별도 에이전트로 등록하여 전용 AGENTS.md 사용

### 3.3 카테고리별 행동 주입 불가 (Medium)

현재 구조에서는 모델만 `sessions_spawn(model: "...")` 로 변경 가능하고, 행동 지침은 `task` 파라미터에 텍스트로 넣을 수밖에 없음.

**해결**: 서브에이전트별 전용 AGENTS.md로 행동 주입

---

## 4. 핵심 발견: agentId별 Workspace Bootstrap

`sessions_spawn(agentId: "explorer")` 호출 시:

1. `targetAgentId = "explorer"`
2. `childSessionKey = "agent:explorer:subagent:{uuid}"`
3. `resolveAgentWorkspaceDir(cfg, "explorer")` → `~/.openclaw/workspace-explorer/`
4. Bootstrap: `workspace-explorer/AGENTS.md` 로드
5. `promptMode = "minimal"` (isSubagentSessionKey이므로)

| 항목      | agentId 미지정 (현재)    | agentId 지정 (신규)             |
| --------- | ------------------------ | ------------------------------- |
| workspace | 부모와 동일              | **서브에이전트의 workspace**    |
| AGENTS.md | 부모의 전체 AGENTS.md    | **서브에이전트 전용 AGENTS.md** |
| 도구      | 부모와 동일 + deny       | **서브에이전트의 tools.allow**  |
| 모델      | 부모 또는 model 파라미터 | **서브에이전트의 model**        |

필요 조건:

1. `openclaw.json`의 `agents.list`에 서브에이전트 등록
2. 부모 에이전트의 `subagents.allowAgents`에 서브에이전트 ID 추가
3. 서브에이전트의 workspace 디렉토리에 AGENTS.md 생성
4. `discord.bots`에는 추가하지 않음 → Discord에 노출되지 않음

---

## 5. 목표 아키텍처 (To-Be)

### 5.1 전체 구조

```
  Discord User
      │
      ▼
  부모 에이전트 (ruda, eden, seum, dajim, yunseul, ...)
  ┌─────────────────────────────────────────────────────┐
  │ AGENTS.md                                            │
  │ ├─ 에이전트 고유 역할/성격                              │
  │ ├─ Orchestration Pattern (NEW)                       │
  │ │   ├─ 핵심 원칙: 도구 vs 에이전트                      │
  │ │   ├─ Intent Gate (직접 vs 위임 판단)                 │
  │ │   ├─ Spawn Guide (서브에이전트 매핑)                  │
  │ │   ├─ Fan-out / Fan-in 패턴                          │
  │ │   └─ 비용 가드레일                                   │
  │ └─ (축약된) Task/Memory/기타 규칙                       │
  └─────────────────────────────────────────────────────┘
      │
      ├─ 직접 → read/write/edit/exec (도구 호출)
      │
      └─ 위임 → sessions_spawn(agentId="서브에이전트ID", ...)
               │
               ▼
        ┌──────────────────────────────────────────────┐
        │ Sub-Agents (4종)                              │
        │                                               │
        │ explorer ─── 읽기 전용 탐색 (sonnet-4-5)       │
        │ worker-quick ─ 빠른 작업 실행 (sonnet-4-5)     │
        │ worker-deep ── 심층 구현 (opus-4-5)            │
        │ consultant ── 아키텍처 상담 (opus-4-6)          │
        │                                               │
        └──────────────────────────────────────────────┘
               │
               ▼
        Announce → 부모가 결과 수신 → 검증 → 유저에게 전달
```

### 5.2 핵심 원칙: 도구 vs 에이전트

```
도구 = 나의 손과 눈   → 내가 생각하고, 도구가 실행
에이전트 = 다른 사람   → 목표만 주면 스스로 생각 + 실행
```

| 판단 기준                   | 도구로 직접 처리      | 에이전트에게 위임        |
| --------------------------- | --------------------- | ------------------------ |
| 뭘 해야 하는지 아는가?      | ✅ 위치와 방법을 안다 | ❌ 탐색/판단이 먼저 필요 |
| 몇 단계인가?                | 1-2단계               | 3단계 이상               |
| 내 대화 맥락에 답이 있는가? | ✅ 이미 알고 있다     | ❌ 새로 찾아야 한다      |
| 특화된 시각이 필요한가?     | ❌ 일반적 처리        | ✅ 전문 분석/추론 필요   |
| 병렬화 이득이 있는가?       | ❌ 순차적이면 충분    | ✅ 여러 작업을 동시에    |

---

## 6. Sub-Agent 정의 (4종)

### 6.1 개요

| 서브에이전트 | agentId        | 모델      | 역할           | timeout | 비용 |
| ------------ | -------------- | --------- | -------------- | ------- | ---- |
| Explorer     | `explorer`     | codex-5.3 | 읽기 전용 탐색 | 120s    | 저   |
| Worker-Quick | `worker-quick` | codex-5.3 | 단순 수정      | 60s     | 저   |
| Worker-Deep  | `worker-deep`  | codex-5.3 | 복잡한 구현    | 600s    | 중   |
| Consultant   | `consultant`   | codex-5.3 | 아키텍처 상담  | 900s    | 고   |

### 6.2 선택 가이드

```
작업 판단
    │
    ├─ 정보가 부족, 먼저 파악 필요 ──────────── explorer
    │
    ├─ 뭘 해야 하는지 알고, 단순 수정 ──────── worker-quick
    │
    ├─ 복잡한 구현, 자율 판단 필요 ──────────── worker-deep
    │
    ├─ 아키텍처 결정, 의견 필요 ────────────── consultant
    │
    └─ 1-2단계로 끝나는 일 ─────────────────── 도구로 직접 (spawn 안 함)
```

### 6.3 Explorer

- **역할**: 코드베이스 탐색, 패턴 발견, 정보 수집
- **도구**: read, exec (읽기 전용만), web_search, web_fetch
- **규칙**: 절대 파일 수정 금지, 확인된 사실만 보고, 절대 경로 사용

### 6.4 Worker-Quick

- **역할**: 단순 파일 수정, 오타 교정, 설정 변경
- **도구**: read, write, edit, exec
- **규칙**: 지시 범위 초과 금지, 수정 전 현재 상태 확인 필수

### 6.5 Worker-Deep

- **역할**: 복잡한 코드 분석, 다중 파일 구현, 아키텍처 수정
- **도구**: read, write, edit, exec, browser, web_search, web_fetch
- **규칙**: 자율 판단 허용, 기존 코딩 스타일 준수, 테스트 검증 필수
- **금지**: `as any`/`@ts-ignore`, 빈 catch 블록, 테스트 삭제, git push

### 6.6 Consultant

- **역할**: 아키텍처 결정, 디자인 리뷰, 트레이드오프 분석
- **도구**: read, web_search, web_fetch
- **규칙**: 절대 파일 수정 금지, 여러 선택지 비교 시 트레이드오프 제시 필수

### 6.7 공통: Task 도구 차단

모든 서브에이전트에서 task/milestone 도구 차단:

- task_start, task_update, task_complete, task_status, task_list, task_cancel, task_block, task_approve, task_resume, task_backlog_add, task_pick_backlog
- milestone_list, milestone_create, milestone_add_item, milestone_assign_item, milestone_update_item

**이유**: Task 추적은 오직 부모 에이전트만 수행. 서브에이전트가 task 도구를 사용하면 부모의 task 상태가 오염됨.

### 6.8 Bootstrap 범위

Sub-agent는 bootstrap 시 **AGENTS.md와 TOOLS.md만** 로딩됨 (SOUL.md, IDENTITY.md 등 미로딩).
read/write/edit/exec 도구는 시스템 전체에 접근 가능 — 부모가 task에 파일 경로를 **명시적으로 전달**해야 함.

---

## 7. Orchestration 패턴

### 7.1 Spawn 방법

```
sessions_spawn(
  agentId: "서브에이전트ID",
  task: """
  [목표] 한 문장 요약
  [컨텍스트] 파일 경로, 기존 패턴, 참고 사항
  [MUST DO] 구체적 행동 1, 2, 3
  [MUST NOT] 금지 행동
  [출력] 기대하는 결과물 형식
  """,
  label: "간결한-라벨",
  runTimeoutSeconds: 타임아웃(초)
)
```

### 7.2 Task + Sub-Agent 연동

부모 에이전트만 task를 관리. 서브에이전트는 task 도구 미사용.

**기본 플로우 (직접 처리)**:

```
유저 요청 → task_start → 도구로 작업 → task_complete → 유저에게 전달
```

**단일 위임 플로우**:

```
유저 요청 → task_start → task_update("위임")
  → sessions_spawn → announce 수신
  → 검증 → task_complete → 유저에게 전달
```

**다단계 위임 (탐색 → 구현)**:

```
유저 요청 → task_start
  → explorer spawn → announce (탐색 결과)
  → worker-deep spawn (탐색 결과 포함) → announce (구현 결과)
  → task_complete → 유저에게 전달
```

**병렬 Fan-out**:

```
유저 요청 → task_start
  → explorer spawn (auth 분석) + explorer spawn (DB 분석)
  → 양쪽 announce 수신
  → worker-deep spawn (양쪽 결과 포함)
  → task_complete → 유저에게 전달
```

### 7.3 결과 검증 (Fan-in)

Announce 수신 시 4가지 확인:

1. 기대한 결과가 나왔는가? (task의 [출력] 조건 충족)
2. 기존 코드 패턴을 따랐는가?
3. [MUST DO]를 다 했는가?
4. [MUST NOT]을 지켰는가?

실패 시 재spawn (최대 1회). **이전 결과 + 실패 이유를 task에 반드시 포함**.
2회 연속 실패 → 3가지 선택지:

- A. 부모가 직접 수정
- B. consultant에게 상담 요청
- C. 유저에게 상황 보고

### 7.4 타임아웃/에러 처리

| Announce 상태            | 대응                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| "completed successfully" | 정상 — 검증 체크리스트 진행                                         |
| "timed out"              | 부분 결과 확인 → 쓸 수 있으면 사용, 없으면 스코프 축소 재spawn      |
| "failed: {error}"        | 에러 분석 → 수정 재spawn 또는 유저 보고                             |
| "(no output)"            | explorer/worker-quick → 재spawn, worker-deep/consultant → 유저 보고 |

### 7.5 비용 가드레일

- 도구로 직접 할 수 있으면 에이전트 쓰지 않는다
- 의심되면 한 단계 낮은 서브에이전트로 시작
- explorer/worker-quick 먼저, 필요 시 worker-deep
- consultant는 정말 복잡한 판단이 필요할 때만
- Sonnet 에이전트는 consultant 사용 불가 (비용 역전 방지)

### 7.6 위임 금지 대상

- 유저와의 감정적/맥락적 대화
- 비밀번호, 인증 정보 필요 작업
- 되돌릴 수 없는 파괴적 작업 (삭제, 배포)
- 단순 예/아니오 판단
- 이미 답을 알고 있는 것

---

## 8. 부모 에이전트 allowAgents 매핑

| 부모 에이전트 | 모델       | allowAgents                                     |
| ------------- | ---------- | ----------------------------------------------- |
| ruda          | opus-4-6   | explorer, worker-quick, worker-deep, consultant |
| eden          | opus-4-5   | explorer, worker-quick, worker-deep, consultant |
| seum          | opus-4-5   | explorer, worker-quick, worker-deep, consultant |
| dajim         | opus-4-5   | explorer, worker-quick, worker-deep, consultant |
| yunseul       | sonnet-4-5 | explorer, worker-quick, worker-deep             |
| miri          | sonnet-4-5 | explorer, worker-quick, worker-deep             |
| onsae         | sonnet-4-5 | explorer, worker-quick, worker-deep             |
| ieum          | sonnet-4-5 | explorer, worker-quick, worker-deep             |
| nuri          | sonnet-4-5 | explorer, worker-quick, worker-deep             |
| hangyeol      | sonnet-4-5 | explorer, worker-quick, worker-deep             |
| grim          | sonnet-4-5 | explorer, worker-quick, worker-deep             |

Sonnet 에이전트에서 consultant 제외 이유: Sonnet이 codex-5.3 consultant를 spawn하면 비용 역전.

---

## 9. 카테고리 → 서브에이전트 매핑

oh-my-opencode의 카테고리와 openclaw 서브에이전트 대응:

| oh-my-opencode 카테고리 | 서브에이전트 매핑                 | 근거                                   |
| ----------------------- | --------------------------------- | -------------------------------------- |
| quick                   | `worker-quick`                    | 1:1 — 단순 수정, 설정 변경             |
| writing                 | `worker-quick` 또는 `worker-deep` | 짧은 문서 → quick, 긴 문서 → deep      |
| visual-engineering      | `worker-deep`                     | 프론트엔드 구현은 복잡한 판단 필요     |
| artistry                | `worker-deep` + consultant 선상담 | 창의적 접근 필요 시 consultant 먼저    |
| deep                    | `worker-deep`                     | 1:1 — 복잡한 구현, 자율 판단           |
| ultrabrain              | `consultant` → `worker-deep`      | consultant가 설계 → worker-deep이 구현 |

openclaw에서는 카테고리 이름 대신 **서브에이전트 이름으로 직접 선택**.

---

## 10. 모델 오버라이드

`sessions_spawn`에서 `model` 파라미터로 모델을 일시적으로 덮어쓸 수 있음.

| 시나리오                     | 오버라이드            | 이유                        |
| ---------------------------- | --------------------- | --------------------------- |
| explorer가 매우 복잡한 분석  | `model: "opus-4-5"`   | sonnet으로는 깊은 분석 부족 |
| worker-deep이 단순 반복 작업 | `model: "sonnet-4-5"` | opus가 과한 비용            |
| consultant가 단순 비교       | `model: "opus-4-5"`   | opus-4-6이 과한 비용        |

기본 모델은 openclaw.json에서 관리. 오버라이드는 **예외 상황**에만.

---

## 11. 변경 요약

| 항목                | As-Is                   | To-Be                                      |
| ------------------- | ----------------------- | ------------------------------------------ |
| sub-agent workspace | 부모와 동일             | **서브에이전트별 독립**                    |
| sub-agent AGENTS.md | 부모와 동일 (과잉 주입) | **서브에이전트별 전용**                    |
| 카테고리 주입       | task 텍스트에 의존      | **agentId로 서브에이전트 선택**            |
| Orchestration 지침  | 없음                    | **부모 AGENTS.md에만 삽입**                |
| 도구 제어           | 전역 deny만             | **서브에이전트별 tools.allow + 전역 deny** |
| task 도구           | sub-agent도 사용 가능   | **sub-agent에서 차단**                     |

---

_원본: `/tmp/openclaw-final-design/` (01-DESIGN.md, 03-SUBAGENTS.md, 04-ORCHESTRATION.md)_
_작성일: 2026-02-13_
