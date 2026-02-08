# 06. 지우 (Integrator / Release Captain)

## 1. 역할 정의 & 책임 범위
- **Role**: Integrator / Release Captain
- **Summary**: 병렬로 실행되는 여러 Claude Code 에이전트와 팀원들의 작업물을 중앙에서 수집, 검증, 통합하고 최종 릴리즈를 책임지는 역할.
- **Key Responsibilities**:
  - **결과물 수집**: 각 세션(outbox/logs/artifacts)의 산출물을 표준 형식으로 모으기
  - **통합 게이트**: merge/rebase/tag/release 전 체크리스트 강제
  - **충돌 예방**: 작업ID/네이밍 규칙, worktree/브랜치 전략, 동시쓰기 방지 규칙
  - **릴리즈 운영**: 릴리즈 노트, 버전 관리, changelog 자동화, pre-merge check
  - **아카이브**: 결정사항/리서치 링크/로그를 share/artifacts & outbox로 정리

## 2. 관찰된 Pain Points (Internal Analysis)
1. **병렬 세션 충돌**: 여러 에이전트가 동시에 파일을 수정하거나, 서로 다른 작업 브랜치에서 충돌 발생 가능성.
2. **로그 파편화**: 각 에이전트의 실행 로그가 분산되어 있어 전체 진행 상황을 파악하기 어려움.
3. **릴리즈 일관성 부족**: 수동으로 릴리즈 노트 작성 시 누락 발생, 버전 태깅의 불규칙성.

## 3. Recommended Toolkit (15 Curated Tools)

> **선정 기준**: GitHub Star/Activity, Claude Code 호환성, 병렬/비동기 작업 최적화.

### (A) 병렬 개발 통합 (Parallel Dev Integration)
*(Researching...)*

### (B) 릴리즈 & 버전 관리 (Release Automation)
*(Researching...)*

### (C) 품질 게이트 (Quality Gates)
*(Researching...)*

### (D) 상태 수집 & 아카이브 (Status & Archive)
*(Researching...)*

### (E) Claude Code & MCP Orchestration
*(Researching...)*

## 4. Integrator 운영 표준 플로우 (Standard Operating Procedure)

### 4.1. Worktree & Branch Strategy
- **Parallel Worktrees**: `git worktree`를 활용하여 각 에이전트/작업별로 독립된 작업 공간 할당.
  - 구조: `../worktrees/feat-A`, `../worktrees/fix-B`
- **Branch Naming**: `type/ID-description` (예: `feat/T-123-login-ui`, `fix/T-124-api-timeout`)
- **Merge Flow**: Feature Branch -> Integration Branch (Local Test) -> Main Branch.

### 4.2. Quality Gate Flow
1. **Local Gate (Pre-commit)**: Lint, Format, Basic Test (husky/lefthook).
2. **CI Gate (Pre-merge)**: Full Test Suite, Build, Security Scan (GitHub Actions/act).
3. **Integrator Gate (Manual)**: Conflict Check, Release Note Verification, Semantic Versioning Check.

### 4.4. Troubleshooting (Common Issues)
- **Merge Conflicts in `share/outbox`**: Always pull/rebase before writing to shared logs. Use `append-only` pattern.
- **Stale Branches**: Weekly cleanup of merged branches (`git branch --merged | grep -v main | xargs git branch -d`).
- **Lost Logs**: Ensure all scripts use `tee` to capture stdout/stderr to `share/logs/`.

