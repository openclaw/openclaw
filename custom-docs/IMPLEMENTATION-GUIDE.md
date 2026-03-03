# Sisyphus 패턴 구현 가이드

> 이 문서만 보고 순서대로 실행하면 구현이 완료됨.
> 모든 변경은 서버에서 수행.
>
> 관련 문서: [SISYPHUS-DESIGN.md](./SISYPHUS-DESIGN.md) | [REFERENCES.md](./REFERENCES.md)
>
> **상태**: 구현 완료

---

## 전제 조건

- SSH 접속 가능 (내부 네트워크)
- 설정 파일: `~/.openclaw/openclaw.json`
- Workspace: `~/.openclaw/workspace-{agentId}/`

## 롤백 계획

```bash
# 모든 Phase 시작 전 백업
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M%S)

# 롤백
cp ~/.openclaw/openclaw.json.bak.{timestamp} ~/.openclaw/openclaw.json
openclaw gateway restart
```

---

## Phase 1: 기반 설정 (안전, 서비스 중단 없음)

### Step 1.1: Sub-Agent 도구 차단 추가

**파일**: `~/.openclaw/openclaw.json`
**위치**: `tools` 객체 안에 `subagents` 추가

```jsonc
{
  "tools": {
    "agentToAgent": {
      /* 기존 유지 */
    },
    "subagents": {
      "tools": {
        "deny": [
          "task_start",
          "task_update",
          "task_complete",
          "task_status",
          "task_list",
          "task_cancel",
          "task_block",
          "task_approve",
          "task_resume",
          "task_backlog_add",
          "task_pick_backlog",
          "milestone_list",
          "milestone_create",
          "milestone_add_item",
          "milestone_assign_item",
          "milestone_update_item",
        ],
      },
    },
  },
}
```

### Step 1.2: 서브에이전트 4개 등록

**파일**: `~/.openclaw/openclaw.json`
**위치**: `agents.list` 배열 끝에 추가

```jsonc
{
  "id": "explorer",
  "name": "Explorer",
  "workspace": "/Users/server/.openclaw/workspace-explorer",
  "model": { "primary": "openai-codex/gpt-5.3-codex" },
  "tools": { "allow": ["read", "exec", "web_search", "web_fetch"] }
},
{
  "id": "worker-quick",
  "name": "Worker Quick",
  "workspace": "/Users/server/.openclaw/workspace-worker-quick",
  "model": { "primary": "openai-codex/gpt-5.3-codex" },
  "tools": { "allow": ["read", "write", "edit", "exec"] }
},
{
  "id": "worker-deep",
  "name": "Worker Deep",
  "workspace": "/Users/server/.openclaw/workspace-worker-deep",
  "model": { "primary": "openai-codex/gpt-5.3-codex", "fallbacks": ["openai-codex/gpt-5.2-codex"] },
  "tools": { "allow": ["read", "write", "edit", "exec", "browser", "web_search", "web_fetch"] }
},
{
  "id": "consultant",
  "name": "Consultant",
  "workspace": "/Users/server/.openclaw/workspace-consultant",
  "model": { "primary": "openai-codex/gpt-5.3-codex", "fallbacks": ["openai-codex/gpt-5.2-codex"] },
  "tools": { "allow": ["read", "web_search", "web_fetch"] }
}
```

**중요**: `discord.bots`에는 추가하지 않음 → Discord에 노출되지 않음.

### Step 1.3: 부모 에이전트에 allowAgents 추가

각 부모 에이전트에 `subagents.allowAgents` 추가:

**Opus 에이전트** (ruda, eden, seum, dajim):

```jsonc
"subagents": { "allowAgents": ["explorer", "worker-quick", "worker-deep", "consultant"] }
```

**Sonnet 에이전트** (yunseul, miri, onsae, ieum, nuri, hangyeol, grim):

```jsonc
"subagents": { "allowAgents": ["explorer", "worker-quick", "worker-deep"] }
```

### Step 1.4: 서브에이전트 Workspace + AGENTS.md 생성

```bash
mkdir -p ~/.openclaw/workspace-explorer
mkdir -p ~/.openclaw/workspace-worker-quick
mkdir -p ~/.openclaw/workspace-worker-deep
mkdir -p ~/.openclaw/workspace-consultant
```

각 AGENTS.md 내용 — 아래 섹션 참조:

<details>
<summary><strong>Explorer AGENTS.md</strong> (~/.openclaw/workspace-explorer/AGENTS.md)</summary>

```markdown
# Explorer Sub-Agent

당신은 부모 에이전트가 spawn한 **읽기 전용 탐색 에이전트**입니다.

## 역할

- 코드베이스 탐색, 패턴 발견, 정보 수집
- 파일 내용 읽기, 검색, 구조 분석

## 사용 가능 도구

- `read` — 파일 읽기
- `exec` — 읽기 전용 명령어만 (grep, find, ls, cat 등)
- `web_search`, `web_fetch` — 외부 정보 검색

## 규칙

1. **절대로 파일을 수정하지 않는다**
2. **task 도구 사용 금지** (부모만 관리)
3. exec로 파괴적 명령어 실행 금지 (rm, mv, git push 등)
4. task 파라미터에 명시된 목표만 수행
5. 추측하지 않는다 — 확인된 사실만 보고
6. 파일 경로는 반드시 절대 경로 사용

## 출력 형식

### 탐색 결과

**질문**: [task에서 받은 질문/목표]
**발견**: 1. [구체적 발견] - 파일, 라인, 내용
**패턴/구조**: [발견된 패턴 설명]
**요약**: [1-3문장 결론]
```

</details>

<details>
<summary><strong>Worker-Quick AGENTS.md</strong> (~/.openclaw/workspace-worker-quick/AGENTS.md)</summary>

```markdown
# Worker-Quick Sub-Agent

당신은 부모 에이전트가 spawn한 **빠른 작업 실행 에이전트**입니다.

## 역할

- 단순 파일 수정, 오타 교정, 설정 변경
- 1분 내 완료할 수 있는 작은 작업

## 사용 가능 도구

- `read`, `write`, `edit`, `exec`

## 규칙

1. task의 지시를 **정확하게** 수행
2. **task 도구 사용 금지** (부모만 관리)
3. 지시 범위를 벗어나지 않는다
4. 수정 전 반드시 대상 파일을 읽어서 현재 상태 확인
5. 의심스러우면 하지 않는다

## 출력 형식

### 완료

**작업**: [1줄 요약]
**변경**: [파일 경로]: [변경 내용]
**검증**: [확인 사항]
```

</details>

<details>
<summary><strong>Worker-Deep AGENTS.md</strong> (~/.openclaw/workspace-worker-deep/AGENTS.md)</summary>

```markdown
# Worker-Deep Sub-Agent

당신은 부모 에이전트가 spawn한 **심층 작업 실행 에이전트**입니다.

## 역할

- 복잡한 코드 분석, 다중 파일 구현, 아키텍처 수정
- 자율적으로 조사하고 최선의 방법을 찾아 실행

## 사용 가능 도구

- `read`, `write`, `edit`, `exec`, `browser`, `web_search`, `web_fetch`

## 규칙

1. task의 목표를 달성하기 위해 **자율적으로** 판단
2. **task 도구 사용 금지** (부모만 관리)
3. 변경 전 반드시 기존 코드를 먼저 읽고 패턴 파악
4. 기존 코딩 스타일과 패턴을 따른다
5. 테스트가 있으면 실행하여 검증

## 금지 사항

- `as any`, `@ts-ignore`, `@ts-expect-error` 등 타입 억제
- 빈 catch 블록, 기존 테스트 삭제, git push

## 출력 형식

### 완료

**목표**: [task에서 받은 목표]
**접근 방식**: [선택한 방법 + 이유]
**변경 사항**: [파일별 변경 내용]
**검증**: 테스트/빌드/린트 결과
**주의 사항**: [후속 작업, 잠재적 영향]
```

</details>

<details>
<summary><strong>Consultant AGENTS.md</strong> (~/.openclaw/workspace-consultant/AGENTS.md)</summary>

```markdown
# Consultant Sub-Agent

당신은 부모 에이전트가 spawn한 **고급 상담 에이전트**입니다.

## 역할

- 아키텍처 결정, 디자인 리뷰, 트레이드오프 분석
- 복잡한 문제에 대한 깊은 사고와 조언

## 사용 가능 도구

- `read` — 파일 읽기
- `web_search`, `web_fetch` — 최신 정보 확인

## 규칙

1. **절대로 파일을 수정하지 않는다**
2. **task 도구 사용 금지** (부모만 관리)
3. 여러 선택지 비교 시 반드시 트레이드오프 제시
4. 불확실한 부분은 명시적으로 "확실하지 않음" 표시
5. 실행 가능한 조언을 한다

## 출력 형식

### 분석 결과

**질문**: [task에서 받은 질문]
**분석**: [깊은 분석 — 현재 상태, 문제점, 가능성]
**선택지**: | 옵션 | 장점 | 단점 | 적합 상황 |
**추천**: [옵션] — [근거]
**리스크**: [위험 요소]
**다음 단계**: [구체적 실행 계획]
```

</details>

### Step 1.5: Gateway Restart

```bash
openclaw gateway restart
```

---

## Phase 2: 부모 에이전트 AGENTS.md 업데이트

### Step 2.1: Orchestration 패턴 삽입

삽입 위치: AGENTS.md의 에이전트 고유 역할/성격 섹션 바로 뒤, Task Management 섹션 앞.

**Opus 에이전트** (ruda, eden, seum, dajim) → Opus 풀 버전 (~4,500 bytes)
**Sonnet 에이전트** (yunseul, miri, onsae, ieum, nuri, hangyeol, grim) → Sonnet 라이트 버전 (~2,000 bytes)

Orchestration 패턴 전문은 [SISYPHUS-DESIGN.md §7](./SISYPHUS-DESIGN.md#7-orchestration-패턴) 참조.

### Step 2.2: 중복 보일러플레이트 축약 (선택)

유저 승인 후 진행. Orchestration 패턴을 먼저 삽입하고 테스트한 뒤에 축약.

| 섹션             | 현재 크기    | 축약 후    | 절약                          |
| ---------------- | ------------ | ---------- | ----------------------------- |
| Task Management  | ~4,230 bytes | ~100 bytes | system-prompt.ts에 하드코딩됨 |
| Self-Improvement | ~2,500 bytes | ~200 bytes | 핵심 규칙만 유지              |
| Heartbeats       | ~1,200 bytes | ~200 bytes | HEARTBEAT.md에 별도 주입      |
| DM Reply Rule    | ~634 bytes   | ~150 bytes | 예시 제거                     |
| Daily Compaction | ~962 bytes   | ~150 bytes | 형식만 유지                   |

총 절약: 에이전트당 ~8,000-9,000 bytes → bootstrap 용량(20,000 chars) 여유 확보

---

## Phase 3: 검증

### Test 1: Explorer Spawn

Discord에서 에이전트에게: "이 프로젝트의 인증 구조를 분석해줘 (서브에이전트 사용해서)"

기대: `sessions_spawn(agentId: "explorer")` → explorer AGENTS.md 로드 → read/exec만 사용 → announce 반환

### Test 2: Worker-Quick Spawn

"config.json에서 포트 번호를 3000에서 4000으로 바꿔줘 (서브에이전트로)"

기대: `sessions_spawn(agentId: "worker-quick")` → read → edit → 60s 내 완료

### Test 3: Worker-Deep Spawn

"이 모듈의 에러 핸들링을 개선해줘 (서브에이전트로 깊이 있게)"

기대: `sessions_spawn(agentId: "worker-deep")` → 자율 분석 → 구현 → 600s 내 완료

### Test 4: Task 도구 차단 확인

Sub-agent 도구 목록에 task\_\* 도구가 없는지 확인.

### Test 5: 병렬 Fan-out

"프로젝트의 인증 구조와 DB 스키마를 동시에 분석해줘"

기대: 2개 explorer 동시 spawn → 양쪽 announce 수신 → 통합 전달

---

## Phase 4: 코드 개선 (선택, 나중에)

Config만으로 해결되지 않는 근본적 개선. prontolab-openclaw 소스 코드 수정 필요.

### 4.1 DEFAULT_SUBAGENT_TOOL_DENY에 task/milestone 추가

**파일**: `src/agents/pi-tools.policy.ts:79-96`

기존 11개 + task/milestone 도구 추가. Config 설정 없이도 기본 차단.

### 4.2 Task Tracking 조건부 처리

**파일**: `src/agents/system-prompt.ts:414-417`

`promptMode="minimal"` (sub-agent)일 때 Task Tracking 섹션 생략.

### 4.3 Sub-agent bootstrapMode 추가 (최저 우선순위)

현재 agentId 기반 workspace 분리로 해결 가능하므로 최저 우선순위.

---

## 실행 순서 요약

```
[Phase 1 — 안전, 서비스 중단 없음]
  1.1 tools.subagents.tools.deny 추가 ─────── openclaw.json
  1.2 서브에이전트 4개 등록 ────────────── openclaw.json
  1.3 부모 에이전트 allowAgents 추가 ─────── openclaw.json
  1.4 Workspace + AGENTS.md 4개 생성 ────── 파일 생성
  1.5 Gateway restart ────────────────── 명령어

[Phase 2 — AGENTS.md 수정]
  2.1 Orchestration 패턴 삽입 ─────────── 11개 파일
  2.2 중복 보일러플레이트 축약 (선택) ────── 11개 파일

[Phase 3 — 검증]
  3.1-3.5 Discord에서 테스트 ──────────── 수동

[Phase 4 — 코드 개선 (선택)]
  4.1-4.3 소스 코드 수정 ─────────────── 코드
```

---

_원본: `/tmp/openclaw-final-design/02-IMPLEMENTATION.md`_
_작성일: 2026-02-13_
