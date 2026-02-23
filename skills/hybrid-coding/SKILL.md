---
name: hybrid-coding
description: "3-Layer 멀티에이전트 코딩 아키텍처. MAIBOT(오케스트레이터) → OpenClaw Sub-agent(태스크 병렬화) → Claude Code CLI(전문 에이전트 실행). 프로젝트 초기화, 멀티에이전트 실행, 모델 혼합 전략 포함. Use when: (1) 새 프로젝트에 멀티에이전트 코딩 적용, (2) 복잡한 작업을 병렬 분배, (3) Claude Code 에이전트 팀 구성. NOT for: 단순 파일 편집(Edit 도구), 코드 읽기(Read 도구)."
metadata:
  openclaw:
    emoji: "🏗️"
    requires:
      anyBins: ["claude"]
---

# 3-Layer 멀티에이전트 코딩

MAIBOT(오케스트레이터) + OpenClaw Sub-agent(병렬화) + Claude Code CLI(실행) 아키텍처.

## 아키텍처 개요

```
지니님 (Discord)
    ↓
Layer 1: MAIBOT (OpenClaw, Opus 4.6) ← 총괄 오케스트레이터
    │   • 태스크 분석/분배
    │   • 결과 취합/보고
    │   • 단순 작업은 직접 처리
    │
    ├── Layer 2: sessions_spawn → Sub-agent A (OpenClaw 서브에이전트)
    │     └── Layer 3: claude -p --agent {전문에이전트} '태스크'
    │           └── Claude Code CLI (Max 구독, 69개 에이전트)
    │
    ├── sessions_spawn → Sub-agent B
    │     └── claude -p --agent {전문에이전트} '태스크'
    │
    └── sessions_spawn → Sub-agent C
          └── claude -p --agent {전문에이전트} '태스크'
```

## 핵심 원칙

### 태스크 라우팅 (어디서 실행할지)

| 작업 유형                               | 실행 위치       | 모델           | 동시 실행 |
| --------------------------------------- | --------------- | -------------- | --------- |
| **단순** (파일 편집, 설정 변경, 문서)   | MAIBOT 직접     | Opus (기존)    | 무제한    |
| **중간** (기능 구현, 버그 수정, 테스트) | Claude Code CLI | **Sonnet 4.6** | 2~3개     |
| **복잡** (설계, 리팩토링, 아키텍처)     | Claude Code CLI | **Opus 4.6**   | 1개       |

### 모델 혼합 전략 (Rate Limit 관리)

Max 20x 구독의 rate limit은 ~5시간 롤링 윈도우로 리셋.

```
전체 작업량 분배 (권장):
├── 60% → MAIBOT 직접 처리 (rate limit 무관)
├── 30% → Claude Code Sonnet (rate limit 넉넉)
└── 10% → Claude Code Opus (복잡한 작업만)
```

**Sonnet 4.6은 Opus 4.6급 코딩 성능을 1/2 가격·토큰으로 제공** → 기본 모델로 Sonnet 사용.

### 동시 실행 제한 (슬롯 시스템)

```
MAIBOT 오케스트레이터
    ├── Slot 1: claude (Sonnet) — 실행 중
    ├── Slot 2: claude (Sonnet) — 실행 중
    ├── Slot 3: claude (Opus)  — 복잡 작업용 (선택적)
    └── 대기열: [다음 태스크들...] ← 슬롯 빌 때 순차 투입
```

- **Sonnet 슬롯: 최대 2개** 동시
- **Opus 슬롯: 최대 1개** 동시
- rate limit 경고 시 → 슬롯 줄이거나 MAIBOT 직접 처리로 전환

## Claude Code CLI 실행 패턴

### 기본 호출 (MAIBOT에서)

```bash
# 패턴 1: exec로 직접 호출 (PTY 필수!)
exec pty:true workdir:"C:\TEST\{프로젝트}" command:"claude -p --model sonnet --agent backend-architect '태스크 설명'"

# 패턴 2: 백그라운드 실행 (긴 작업)
exec pty:true background:true workdir:"C:\TEST\{프로젝트}" command:"claude -p --model sonnet --agent frontend-architect '태스크 설명'"

# 패턴 3: 서브에이전트에서 호출
sessions_spawn task:"C:\TEST\{프로젝트} 에서 claude -p --agent quality-engineer 'task'"
```

### Claude Code CLI 주요 플래그

| 플래그                                | 용도                                   |
| ------------------------------------- | -------------------------------------- |
| `-p` (--print)                        | 비대화형, 응답 출력 후 종료 — **필수** |
| `--model sonnet/opus`                 | 모델 선택                              |
| `--agent {name}`                      | 전문 에이전트 지정                     |
| `--permission-mode bypassPermissions` | 자동 승인 (sandboxed)                  |
| `--dangerously-skip-permissions`      | 모든 권한 체크 스킵                    |
| `--fallback-model sonnet`             | rate limit 시 자동 전환                |
| `--no-session-persistence`            | 세션 저장 안 함 (토큰 절약)            |
| `--max-budget-usd N`                  | 비용 제한 (아래 가이드라인 참고)       |

### 예산 가이드라인 (--max-budget-usd)

| 작업 유형               | 예산              | 예시                           |
| ----------------------- | ----------------- | ------------------------------ |
| 단순 (파일 1~2개 생성)  | `$1`              | 설정 파일, 간단한 유틸리티     |
| 중간 (문서 참조 + 구현) | `$3` ← **기본값** | 기능 구현, DB 스키마, API      |
| 복잡 (설계 + 다중 파일) | `$5`              | 아키텍처 설계, 대규모 리팩토링 |

> ⚠️ $1은 문서 읽기+코드 생성 시 초과됨 (실측). 기본 $3 권장.

### MCP 전략

이전 폐기 원인: MCP 서버/plugins 로딩 충돌로 hang.

**MCP 로딩 오버헤드: ~10초** (서버 4~5개 시작). 작업 유형별 전략:

| 작업 유형      | MCP 전략                    | 이유                        |
| -------------- | --------------------------- | --------------------------- |
| 코드 생성/편집 | 기본 로드 (감수)            | 10초 대기 but 안정적        |
| 웹 참조 필요   | 기본 로드                   | fetcher, context7 활용      |
| 빠른 원샷      | 프로젝트 `.mcp.json` 최소화 | 불필요 MCP 줄여서 시간 단축 |

```bash
# 권장: 기본 MCP 로드 (가장 안정적, ~10초 대기)
claude -p "task"

# 프로젝트 MCP만 사용 (글로벌 MCP 제외)
claude -p --strict-mcp-config --mcp-config .mcp.json "task"
```

> ⚠️ `--strict-mcp-config --mcp-config '{}'` (빈 JSON)은 **Windows에서 hang** 발생 — 사용 금지.
> MCP 완전 스킵이 필요하면 빈 파일 사용: `--strict-mcp-config --mcp-config C:\TEST\.empty-mcp.json`
> (`.empty-mcp.json` 내용: `{"mcpServers":{}}`)

## Agent Teams (실험 기능)

Claude Code 자체 멀티에이전트 — 공유 태스크 리스트로 세션 간 협업.

```powershell
# 환경변수 활성화
$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"

# Claude Code가 직접 팀 구성
claude "에이전트 팀을 만들어서 리팩토링해줘:
  1. API 레이어 담당
  2. DB 마이그레이션 담당
  3. 테스트 커버리지 담당
  공유 태스크 리스트로 협업해"
```

**주의:** 실험 기능이므로 안정성 확인 필요. 안정적인 운영에는 Layer 1-2-3 패턴 권장.

## 사용 가능한 Claude Code 에이전트 (69개)

### User 에이전트 (17개) — 범용

| 에이전트                 | 용도                       |
| ------------------------ | -------------------------- |
| `system-architect`       | 시스템 설계, 아키텍처 결정 |
| `backend-architect`      | 백엔드 API, 서버 로직      |
| `frontend-architect`     | UI/UX, 프론트엔드 구현     |
| `devops-architect`       | 배포, CI/CD, 인프라        |
| `security-engineer`      | 보안 감사, 취약점 수정     |
| `performance-engineer`   | 성능 최적화, 프로파일링    |
| `quality-engineer`       | 테스트 작성, QA            |
| `python-expert`          | Python 전문 작업           |
| `refactoring-expert`     | 코드 리팩토링              |
| `technical-writer`       | 문서화                     |
| `deep-research-agent`    | 깊은 리서치                |
| `pm-agent`               | 프로젝트 관리              |
| `requirements-analyst`   | 요구사항 분석              |
| `root-cause-analyst`     | 근본 원인 분석             |
| `learning-guide`         | 학습 가이드                |
| `socratic-mentor`        | 소크라틱 멘토링            |
| `business-panel-experts` | 비즈니스 패널              |

### Plugin 에이전트 (주요) — 전문 워크플로우

| 카테고리                 | 에이전트                         | 용도             |
| ------------------------ | -------------------------------- | ---------------- |
| **compound-engineering** | `design-implementation-reviewer` | 디자인 구현 리뷰 |
|                          | `best-practices-researcher`      | 모범 사례 조사   |
|                          | `code-simplicity-reviewer`       | 코드 단순화 리뷰 |
|                          | `security-sentinel`              | 보안 감시        |
|                          | `bug-reproduction-validator`     | 버그 재현 검증   |
|                          | `pr-comment-resolver`            | PR 코멘트 해결   |
| **dev-workflows**        | `task-decomposer`                | 태스크 분해      |
|                          | `task-executor`                  | 태스크 실행      |
|                          | `code-reviewer`                  | 코드 리뷰        |
|                          | `solver`                         | 문제 해결        |
|                          | `verifier`                       | 검증             |
| **frontend-excellence**  | `react-specialist`               | React 전문       |
|                          | `css-expert`                     | CSS 전문         |
|                          | `component-architect`            | 컴포넌트 설계    |

### 프로젝트 유형별 추천 에이전트 조합

| 프로젝트 유형     | Opus (복잡)       | Sonnet (구현)                         | MAIBOT (단순) |
| ----------------- | ----------------- | ------------------------------------- | ------------- |
| **웹앱**          | system-architect  | frontend-architect, backend-architect | 설정, 문서    |
| **AI/ML**         | system-architect  | python-expert, quality-engineer       | 데이터, 설정  |
| **API 서비스**    | backend-architect | quality-engineer, devops-architect    | 문서, 설정    |
| **모바일 (Expo)** | system-architect  | frontend-architect, quality-engineer  | 설정, 에셋    |

## 프로젝트 초기화

### 필요 파일 3종

#### 1. CLAUDE.md (프로젝트 루트)

Claude Code가 자동 참조하는 프로젝트 가이드:

```markdown
# 프로젝트명

## 개요

프로젝트 설명

## 멀티에이전트 코딩

MAIBOT(오케스트레이터) → Claude Code CLI(전문 에이전트) 구조.

- 복잡한 작업: `claude -p --model opus --agent system-architect`
- 구현 작업: `claude -p --model sonnet --agent {전문에이전트}`
- 단순 작업: MAIBOT 직접 처리

## 기술 스택

- ...

## 핵심 규칙

- ...
```

#### 2. .claude/agents/\*.md (프로젝트 전용 에이전트, 선택)

프로젝트 특화 에이전트가 필요하면 생성. User/Plugin 에이전트로 충분하면 스킵.

```markdown
# 에이전트명

에이전트 한줄 설명

## 역할

담당 영역

## 워크스페이스

- src/api/ — API 레이어
- tests/ — 테스트

## 핵심 역량

- 할 수 있는 것

## 규칙

- 지켜야 할 것
```

#### 3. .mcp.json (MCP 서버)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "@playwright/mcp"],
      "description": "브라우저 자동화, E2E 테스트"
    },
    "fetcher": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "fetcher-mcp"],
      "description": "웹 콘텐츠 추출"
    },
    "context7": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "@upstash/context7-mcp"],
      "description": "최신 라이브러리 문서"
    }
  }
}
```

프로젝트별 추가:

- UI 프로젝트: `@magicuidesign/mcp@latest` (UI 컴포넌트)
- DB 프로젝트: `sqlite-mcp` 또는 `postgres-mcp`
- n8n 프로젝트: `n8n-mcp`

### 초기화 체크리스트

새 프로젝트에 적용할 때:

1. [ ] `CLAUDE.md` 생성 (프로젝트 가이드 + 멀티에이전트 패턴)
2. [ ] `.mcp.json` MCP 서버 설정
3. [ ] `.claude/agents/` 프로젝트 전용 에이전트 (필요시)
4. [ ] TOOLS.md에 프로젝트 개발 환경 기록
5. [ ] MEMORY.md에 프로젝트 등록
6. [ ] 테스트 실행: `claude -p --model sonnet "프로젝트 구조 분석해줘"`

## 검증 단계 (필수)

Claude Code 실행 후 MAIBOT이 반드시 검증:

```
Claude Code 에이전트 실행
    ↓
MAIBOT 검증 (Layer 1)
    ├── tsc --noEmit (타입 체크)
    ├── vitest run (테스트)
    └── 코드 리뷰 (Read로 생성된 파일 확인)
    ↓
에러 있으면?
    ├── 단순 타입 에러 → MAIBOT 직접 수정
    ├── 로직 에러 → Claude Code 재실행 (에러 메시지 포함)
    └── 설계 문제 → Opus 에이전트로 에스컬레이션
    ↓
통과 → git commit
```

> 실측: Claude Code는 ~90% 정확하지만 타입 내보내기, ESM 경로 등에서 소소한 에러 발생.
> MAIBOT 검증+수정 패턴으로 100% 커버 가능.

## 실행 레시피

### 레시피 1: 단일 태스크 (가장 흔함)

```bash
# MAIBOT에서 직접 Claude Code 호출
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --max-budget-usd 3 --agent backend-architect 'src/api/comments.ts에 페이지네이션 추가해줘'"

# 검증
exec workdir:"C:\TEST\MAITOK" command:"npx tsc --noEmit"
exec workdir:"C:\TEST\MAITOK" command:"npx vitest run"
```

### 레시피 2: 병렬 멀티에이전트

```bash
# Sub-agent A: 프론트엔드 (Slot 1)
sessions_spawn task:"cd C:\TEST\MAITOK && claude -p --model sonnet --max-budget-usd 3 --agent frontend-architect 'CommentList 컴포넌트에 무한스크롤 구현'"

# Sub-agent B: 백엔드 (Slot 2, 동시 실행)
sessions_spawn task:"cd C:\TEST\MAITOK && claude -p --model sonnet --max-budget-usd 3 --agent backend-architect 'GET /api/comments에 cursor 기반 페이지네이션 추가'"

# A, B 완료 대기 → MAIBOT 검증 (tsc + vitest) → 수정 → 그 다음:
# Sub-agent C: 테스트
sessions_spawn task:"cd C:\TEST\MAITOK && claude -p --model sonnet --max-budget-usd 3 --agent quality-engineer '페이지네이션 관련 테스트 작성'"
```

> ⚠️ 동시 실행: **Sonnet 2개까지 검증 완료** (실측 2026-02-24). 3개 이상은 rate limit 위험.

### 레시피 3: 복잡한 리팩토링

```bash
# Step 1: Opus로 설계 (1개만)
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model opus --agent system-architect '인증 모듈을 JWT에서 OAuth2로 전환하는 설계안 작성. 마이그레이션 계획 포함.'"

# Step 2: 설계 결과 기반으로 Sonnet 병렬 구현
sessions_spawn task:"cd C:\TEST\MAITOK && claude -p --model sonnet --agent backend-architect '설계안에 따라 OAuth2 프로바이더 구현'"
sessions_spawn task:"cd C:\TEST\MAITOK && claude -p --model sonnet --agent frontend-architect '설계안에 따라 로그인 UI 변경'"
```

### 레시피 4: 코드 리뷰

```bash
# git worktree로 격리된 환경에서 리뷰
exec command:"git -C C:\TEST\MAITOK worktree add C:\TEMP\review-pr42 pr-42-branch"
exec pty:true workdir:"C:\TEMP\review-pr42" command:"claude -p --agent code-reviewer 'origin/main과 비교해서 이 PR 리뷰해줘. 보안, 성능, 코드 품질 체크.'"
```

## Rate Limit 대응

### 감지

```bash
# Claude Code가 "rate limit" 에러 반환 시
# → 자동 대응: 슬롯 줄이기 + MAIBOT 직접 처리로 전환
```

### 대응 전략

```
Rate limit 발생 시:
1. 현재 실행 중인 Claude Code 세션 완료 대기
2. 새 Claude Code 호출 중단
3. 대기열의 남은 태스크 → MAIBOT 직접 처리로 전환
4. ~30분 후 Claude Code 재시도
```

### Fallback 체인

```bash
# Claude Code에서 fallback 설정
claude -p --model sonnet --fallback-model haiku "task"

# OpenClaw 레벨 fallback (MAIBOT 직접 처리)
# → sessions_spawn 대신 exec로 직접 편집
```

## 인증 구조

```
Claude Max 구독 ($200/월, 20x)
    │
    ├── MAIBOT (OpenClaw) — setup-token (정적)
    │     저장: ~/.openclaw/agents/main/agent/auth-profiles.json
    │     모델: anthropic/claude-opus-4-6 (기본)
    │
    └── Claude Code CLI — OAuth (자동 갱신)
          저장: ~/.claude/.credentials.json
          모델: 호출 시 --model로 지정
```

**주의:** 같은 구독 공유 → refresh token 충돌 가능 (드묾). OpenClaw token sink가 완화.

## 이력

| 날짜       | 변경                                                     |
| ---------- | -------------------------------------------------------- |
| 2026-02-06 | 하이브리드 코딩 v1 도입 (MAIBOT + Claude Code 단순 호출) |
| 2026-02-07 | v1 폐기 — MCP/plugins 충돌로 hang                        |
| 2026-02-24 | **v2 도입** — 3-Layer 멀티에이전트 아키텍처              |

v1 폐기 원인 해결:

- `--strict-mcp-config` 옵션으로 MCP 충돌 회피
- `-p` (print) 모드로 비대화형 실행 → hang 방지
- 모델 혼합 + 슬롯 시스템으로 rate limit 관리

## 기존 프로젝트 현황

| 프로젝트  | CLAUDE.md | .mcp.json | .claude/agents/ | 멀티에이전트 |
| --------- | :-------: | :-------: | :-------------: | :----------: |
| MAIBEAUTY |    ✅     |    ✅     |       6종       |    미적용    |
| MAIOSS    |    ✅     |    ✅     |       6종       |    미적용    |
| MAIBOT    |    ✅     |    ✅     |       6종       |    미적용    |
| MAITOK    |    ❌     |    ❌     |       ❌        |      ❌      |
| 기타      |    ❌     |    ❌     |       ❌        |      ❌      |
