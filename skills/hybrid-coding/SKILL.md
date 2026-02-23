---
name: hybrid-coding
description: "코딩 작업 위임 + 3-Layer 멀티에이전트. Use when: (1) 기능 구현/빌드, (2) PR 리뷰, (3) 리팩토링, (4) 병렬 멀티에이전트 코딩, (5) 새 프로젝트 멀티에이전트 초기화. NOT for: 단순 파일 편집(Edit), 코드 읽기(Read), MAIBOT 워크스페이스(C:\\MAIBOT) 내 작업."
metadata:
  openclaw:
    emoji: "🏗️"
    requires:
      anyBins: ["claude"]
---

# 코딩 에이전트 (3-Layer 멀티에이전트)

MAIBOT(오케스트레이터) → OpenClaw Sub-agent(병렬화) → Claude Code CLI(실행).

## 아키텍처 개요

```
Layer 1: MAIBOT (OpenClaw, Opus 4.6) ← 총괄 오케스트레이터
    │   • 태스크 분석/분배/검증/수정
    │   • 단순 작업은 직접 처리
    │
    ├── Layer 2: sessions_spawn or exec → Sub-agent
    │     └── Layer 3: claude -p --agent {전문에이전트} '태스크'
    │           └── Claude Code CLI (Max 구독 OAuth, 69개 에이전트)
    │
    └── (병렬 시 Slot 2, 3...)
```

## ⚠️ PTY 필수!

Claude Code CLI는 터미널 앱 — **반드시 `pty:true`** 사용.

```bash
# ✅ 올바름
exec pty:true workdir:"C:\TEST\프로젝트" command:"claude -p 'task'"

# ❌ 잘못됨 — 출력 깨지거나 hang
exec workdir:"C:\TEST\프로젝트" command:"claude -p 'task'"
```

## 태스크 라우팅

| 작업 유형                               | 실행 위치                | 모델           | 동시 실행 |
| --------------------------------------- | ------------------------ | -------------- | --------- |
| **단순** (파일 편집, 설정, 문서)        | MAIBOT 직접 (Edit/Write) | —              | 무제한    |
| **중간** (기능 구현, 버그 수정, 테스트) | Claude Code CLI          | **Sonnet 4.6** | 2개       |
| **복잡** (설계, 리팩토링, 아키텍처)     | Claude Code CLI          | **Opus 4.6**   | 1개       |

### 모델 혼합 (Rate Limit 관리)

Max 20x: ~5시간 롤링 윈도우 리셋. **Sonnet 4.6 = Opus급 코딩을 1/2 토큰으로** → Sonnet 주력.

```
전체 작업: 60% MAIBOT 직접 + 30% Sonnet + 10% Opus
동시 실행: Sonnet 2개 + Opus 1개 (실측 검증)
```

## Claude Code CLI 실행

### 기본 플래그

```bash
claude -p --model sonnet --dangerously-skip-permissions --agent {에이전트} "태스크"
```

| 플래그                           | 용도                              |
| -------------------------------- | --------------------------------- |
| `-p` (--print)                   | 비대화형, 응답 후 종료 — **필수** |
| `--model sonnet/opus`            | 모델 선택                         |
| `--agent {name}`                 | 전문 에이전트 지정                |
| `--dangerously-skip-permissions` | 자동 승인 (모든 권한 체크 스킵)   |
| `--no-session-persistence`       | 세션 저장 안 함 (선택)            |
| `--fallback-model sonnet`        | rate limit 시 자동 전환           |

### 예산 (--max-budget-usd)

**Max/Pro 구독 OAuth: 사용하지 않음.** 월정액이므로 토큰별 과금 없음.
이 플래그는 추정 비용 기반 가상 안전장치 — 구독자에게는 불필요한 중단 유발.

API Key 사용 시만: 단순 $1 / 중간 $3 / 복잡 $5.

### MCP 전략

MCP 로딩: ~10초 (서버 4~5개). 대부분 기본 로드로 감수.

```bash
# 기본 (권장, 안정적)
claude -p "task"

# 프로젝트 MCP만
claude -p --strict-mcp-config --mcp-config .mcp.json "task"
```

> ⚠️ `--strict-mcp-config --mcp-config '{}'`는 **Windows에서 hang** — 사용 금지.

### 프로세스 관리 (백그라운드)

| Action                           | 용도                |
| -------------------------------- | ------------------- |
| `process list`                   | 실행 중인 세션 목록 |
| `process poll sessionId timeout` | 완료 대기           |
| `process log sessionId`          | 출력 확인           |
| `process kill sessionId`         | 세션 종료           |

## 검증 단계 (필수)

Claude Code 실행 후 **MAIBOT이 반드시 검증**:

```
Claude Code 실행 완료
    ↓
MAIBOT 검증 (Layer 1)
    ├── tsc --noEmit (타입 체크)
    ├── vitest run (테스트)
    └── 코드 리뷰 (Read로 생성 파일 확인)
    ↓
에러 시:
    ├── 단순 타입 에러 → MAIBOT 직접 수정 (Edit)
    ├── 로직 에러 → Claude Code 재실행 (에러 메시지 포함)
    └── 설계 문제 → Opus 에이전트로 에스컬레이션
    ↓
통과 → git commit
```

> 실측: Claude Code ~90% 정확. 타입 내보내기, ESM 경로에서 소소한 에러 발생.
> MAIBOT 검증+수정으로 100% 커버.

## 실행 레시피

### 레시피 1: 단일 태스크 (가장 흔함)

```bash
# Claude Code 호출
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent backend-architect 'src/api/comments.ts에 페이지네이션 추가'"

# 검증
exec workdir:"C:\TEST\MAITOK" command:"npx tsc --noEmit"
exec workdir:"C:\TEST\MAITOK" command:"npx vitest run"
```

### 레시피 2: 병렬 멀티에이전트

```bash
# Slot 1: 프론트엔드
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent frontend-architect 'CommentList에 무한스크롤 구현'"

# Slot 2: 백엔드 (동시)
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent backend-architect 'GET /api/comments cursor 페이지네이션'"

# 둘 다 완료 후 → MAIBOT 검증 → 테스트 에이전트
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent quality-engineer '페이지네이션 테스트 작성'"
```

> 동시 실행: **Sonnet 2개 검증 완료** (실측 2026-02-24). 3개 이상은 rate limit 위험.

### 레시피 3: 복잡한 리팩토링

```bash
# Step 1: Opus로 설계 (1개만)
exec pty:true workdir:"C:\TEST\MAITOK" command:"claude -p --model opus --dangerously-skip-permissions --agent system-architect '인증 모듈 JWT→OAuth2 전환 설계안'"

# Step 2: 설계 기반 Sonnet 병렬 구현
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent backend-architect '설계안 따라 OAuth2 프로바이더 구현'"
exec pty:true background:true workdir:"C:\TEST\MAITOK" command:"claude -p --model sonnet --dangerously-skip-permissions --agent frontend-architect '설계안 따라 로그인 UI 변경'"
```

### 레시피 4: PR 리뷰

```bash
# git worktree로 격리
exec command:"git -C C:\TEST\MAITOK worktree add C:\TEMP\review-pr42 pr-42-branch"
exec pty:true workdir:"C:\TEMP\review-pr42" command:"claude -p --dangerously-skip-permissions --agent code-reviewer 'origin/main과 비교 리뷰. 보안, 성능, 코드 품질.'"

# 리뷰 후 정리
exec command:"git -C C:\TEST\MAITOK worktree remove C:\TEMP\review-pr42"
```

### 레시피 5: 이슈 병렬 수정

```bash
# worktree 생성
exec command:"git -C C:\TEST\MAITOK worktree add -b fix/issue-12 C:\TEMP\issue-12 main"
exec command:"git -C C:\TEST\MAITOK worktree add -b fix/issue-15 C:\TEMP\issue-15 main"

# 병렬 수정
exec pty:true background:true workdir:"C:\TEMP\issue-12" command:"claude -p --model sonnet --dangerously-skip-permissions 'Fix issue #12: [설명]. 커밋까지.'"
exec pty:true background:true workdir:"C:\TEMP\issue-15" command:"claude -p --model sonnet --dangerously-skip-permissions 'Fix issue #15: [설명]. 커밋까지.'"

# 완료 후 PR
exec workdir:"C:\TEMP\issue-12" command:"git push -u origin fix/issue-12"
```

## 에이전트 카탈로그 (69개)

### User 에이전트 (17개, 범용)

| 에이전트                 | 모델 권장 | 용도                  |
| ------------------------ | --------- | --------------------- |
| `system-architect`       | Opus      | 시스템 설계, 아키텍처 |
| `backend-architect`      | Sonnet    | 백엔드 API, 서버 로직 |
| `frontend-architect`     | Sonnet    | UI/UX, 프론트엔드     |
| `devops-architect`       | Sonnet    | 배포, CI/CD, 인프라   |
| `security-engineer`      | Sonnet    | 보안 감사, 취약점     |
| `performance-engineer`   | Sonnet    | 성능 최적화           |
| `quality-engineer`       | Sonnet    | 테스트, QA            |
| `python-expert`          | Sonnet    | Python 전문           |
| `refactoring-expert`     | Opus      | 코드 리팩토링         |
| `technical-writer`       | Sonnet    | 문서화                |
| `deep-research-agent`    | Opus      | 깊은 리서치           |
| `pm-agent`               | Sonnet    | 프로젝트 관리         |
| `requirements-analyst`   | Sonnet    | 요구사항 분석         |
| `root-cause-analyst`     | Opus      | 근본 원인 분석        |
| `learning-guide`         | Sonnet    | 학습 가이드           |
| `socratic-mentor`        | Sonnet    | 소크라틱 멘토링       |
| `business-panel-experts` | Opus      | 비즈니스 패널         |

### Plugin 에이전트 (주요)

| 카테고리                 | 에이전트                     | 용도           |
| ------------------------ | ---------------------------- | -------------- |
| **compound-engineering** | `code-simplicity-reviewer`   | 코드 단순화    |
|                          | `security-sentinel`          | 보안 감시      |
|                          | `bug-reproduction-validator` | 버그 재현      |
|                          | `pr-comment-resolver`        | PR 코멘트 해결 |
| **dev-workflows**        | `task-decomposer`            | 태스크 분해    |
|                          | `task-executor`              | 태스크 실행    |
|                          | `code-reviewer`              | 코드 리뷰      |
|                          | `solver`                     | 문제 해결      |
| **frontend-excellence**  | `react-specialist`           | React 전문     |
|                          | `css-expert`                 | CSS 전문       |
|                          | `component-architect`        | 컴포넌트 설계  |

### 프로젝트 유형별 추천

| 유형  | Opus              | Sonnet                          | MAIBOT 직접  |
| ----- | ----------------- | ------------------------------- | ------------ |
| 웹앱  | system-architect  | frontend/backend-architect      | 설정, 문서   |
| AI/ML | system-architect  | python-expert, quality-engineer | 데이터, 설정 |
| API   | backend-architect | quality-engineer, devops        | 문서, 설정   |

## 진행 상황 보고 (필수)

Claude Code를 백그라운드 실행할 때:

1. **시작 시** — Discord DM에 "뭘 실행 중인지 + 어디서" 1줄 알림
2. **변화 시만** 업데이트 — 마일스톤 완료, 에러 발생, 입력 필요, 작업 완료
3. **종료 시** — 변경 내용 + 검증 결과 보고
4. **세션 kill 시** — 즉시 이유 설명

## Rate Limit 대응

```
Rate limit 발생 시:
1. 실행 중 Claude Code 세션 완료 대기
2. 새 호출 중단
3. 대기열 → MAIBOT 직접 처리로 전환
4. ~30분 후 재시도
```

Fallback: `claude -p --model sonnet --fallback-model haiku "task"`

## 프로젝트 초기화 (새 프로젝트)

### 필요 파일

1. **CLAUDE.md** — 프로젝트 가이드 (Claude Code 자동 참조)
2. **.mcp.json** — MCP 서버 설정 (최소: context7)
3. **.claude/agents/\*.md** — 프로젝트 전용 에이전트 (선택, User/Plugin으로 충분하면 스킵)

### 체크리스트

1. [ ] `CLAUDE.md` 생성
2. [ ] `.mcp.json` 설정
3. [ ] MEMORY.md에 프로젝트 등록
4. [ ] 테스트: `claude -p --model sonnet "프로젝트 구조 분석해줘"`

## 인증 구조

```
Claude Max ($200/월 OAuth)
    ├── MAIBOT (OpenClaw) — setup-token
    └── Claude Code CLI — OAuth (자동 갱신)
```

같은 구독 공유, 인증 토큰은 별개. 충돌 드묾.

## 규칙

1. **항상 pty:true** — Claude Code는 터미널 앱
2. **C:\MAIBOT 에서 절대 실행 금지** — 라이브 OpenClaw 인스턴스
3. **세션 느리다고 kill 하지 않기** — 인내심
4. **에이전트 실패 시** — 재실행 or 지니님께 방향 확인, 조용히 대체하지 않기
5. **검증 필수** — tsc + vitest 통과 후 커밋
6. **Max 구독: --max-budget-usd 사용 안 함**

## 이력

| 날짜       | 변경                                              |
| ---------- | ------------------------------------------------- |
| 2026-02-06 | 하이브리드 v1 도입                                |
| 2026-02-07 | v1 폐기 (MCP 충돌)                                |
| 2026-02-24 | **v2** — 3-Layer 멀티에이전트 + coding-agent 통합 |

## 기존 프로젝트 현황

| 프로젝트  | CLAUDE.md | .mcp.json | 멀티에이전트 테스트 |
| --------- | :-------: | :-------: | :-----------------: |
| MAITOK    |    ✅     |    ✅     |    ✅ 검증 완료     |
| MAIBEAUTY |    ✅     |    ✅     |       미적용        |
| MAIOSS    |    ✅     |    ✅     |       미적용        |
| MAIBOT    |    ✅     |    ✅     |       미적용        |
