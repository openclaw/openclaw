---
name: mai-project-init
description: Initialize a new MAI project with local workspace, Obsidian folder, GitHub repo, and MAIBOT memory registration. Use when 지니 says "새 프로젝트", "프로젝트 만들어", "프로젝트 세팅", or asks to set up a new MAI-prefixed project.
---

# MAI Project Init

New MAI project setup — 7 steps, fully automated.

## Required Input

- `PROJECT_NAME`: short name without "MAI" prefix (e.g., "CON" → MAICON)
- `PROJECT_DESC`: 한 줄 프로젝트 설명 (e.g., "AI 로컬 서비스 예약")
- `BRAND_NAME` (optional): 서비스 브랜드명 (e.g., "Tikly")

## Steps

### 1. Local Workspace

```
C:\TEST\MAI{PROJECT_NAME}\
```

Create the directory. Initialize with a basic `.gitignore` and `README.md`.

### 2. Docs Folder

```
C:\TEST\MAI{PROJECT_NAME}\docs\
```

Create `docs/` inside the project. Add a placeholder `README.md`.

#### 문서 명명 규칙

모든 docs 내 문서는 아래 규칙을 따른다:

| 접두사 | 카테고리              | 용도                       | 예시                            |
| ------ | --------------------- | -------------------------- | ------------------------------- |
| `A000` | 분석 (Analysis)       | PRD, 리서치, 아키텍처 리뷰 | `A001-PRD.md`                   |
| `D000` | 설계 (Design)         | 설계 문서, 가이드          | `D001-architecture-overview.md` |
| `I000` | 구현 (Implementation) | 구현 보고서, 개발 로그     | `I001-bugfix-log.md`            |
| `T000` | 테스트 (Test)         | 테스트 결과, E2E 테스트    | `T001-testing-guide.md`         |

- 번호는 각 카테고리별 001부터 순번 부여
- `CHANGELOG.md`, `README.md`, `privacy-policy.md` 등 범용 파일은 규칙 외 허용

### 2.1. Obsidian Dashboard

Obsidian 프로젝트 폴더에 `_DASHBOARD.md` 자동 생성:

```markdown
---
tags: [mai{project_name_lower}, dashboard]
project: MAI{PROJECT_NAME}
local_path: C:\TEST\MAI{PROJECT_NAME}
github: https://github.com/jini92/MAI{PROJECT_NAME}
updated: {today YYYY-MM-DD}
---

# MAI{PROJECT_NAME} Dashboard

> {PROJECT_DESC}

## Overview

| Item       | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| Local Path | `C:\TEST\MAI{PROJECT_NAME}`                                             |
| GitHub     | [jini92/MAI{PROJECT_NAME}](https://github.com/jini92/MAI{PROJECT_NAME}) |

## Current Sprint

| Task            | Status  | Date    |
| --------------- | ------- | ------- |
| 프로젝트 초기화 | ✅ Done | {today} |

## Known Issues

(없음)

---

_Updated by MAIBOT session on {today}_
```

프로젝트 진행에 따라 태스크, 이슈, 아키텍처 등을 업데이트한다.

### 3. Obsidian Project Folder

Base path: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT`

- Determine next number: scan existing `XX.MAI*` folders, pick next sequential number (zero-padded 2 digits).
- Create: `{NN}.MAI{PROJECT_NAME}/`
- Create symlink: `{NN}.MAI{PROJECT_NAME}/docs` → `C:\TEST\MAI{PROJECT_NAME}\docs`

Use `New-Item -ItemType SymbolicLink` (requires elevated or developer mode).

### 4. GitHub Repo

```powershell
cd C:\TEST\MAI{PROJECT_NAME}
git init
git add -A
git commit -m "chore: initial project setup"
gh repo create jini92/MAI{PROJECT_NAME} --private --source=. --push
```

### 5. MAIBOT Memory Registration

- Create `memory/mai{project_name_lower}.md` with project template:

  ```markdown
  # MAI{PROJECT_NAME}

  - **시작일:** {today YYYY-MM-DD}
  - **로컬:** C:\TEST\MAI{PROJECT_NAME}
  - **GitHub:** https://github.com/jini92/MAI{PROJECT_NAME}
  - **Obsidian:** 01.PROJECT/{NN}.MAI{PROJECT_NAME}
  - **상태:** 🟢 진행중

  ## 목표

  (TBD)

  ## 진행상황

  - {today}: 프로젝트 초기화

  ## 결정사항

  (없음)

  ## 다음 액션

  (TBD)
  ```

- Update `MEMORY.md`: add row to 활성 프로젝트 table and 개발 환경 요약 table.

### 6. TEMPLATES/Dashboard.md 등록

파일: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\TEMPLATES\Dashboard.md`

#### 6.1 프로젝트 현황 테이블 업데이트

`🦞 MAI 프로젝트 현황` 섹션의 테이블에 새 프로젝트 행 추가 (MAIBOT 행 바로 위):

```markdown
| {N} | [[{NN}.MAI{PROJECT_NAME}/_DASHBOARD\|MAI{PROJECT_NAME}]] | 🟢 | {PROJECT_DESC} |
```

- `{N}`: 프로젝트 순번 (테이블 내 다음 번호)
- `{NN}`: Obsidian 폴더 번호 (Step 3에서 결정)

#### 6.2 프로젝트 태스크 섹션 추가

기존 태스크 섹션들 사이에 새 프로젝트 태스크 블록 추가 (색상 이모지는 순서대로 🔴🔵🟢🟡🟠🟣🟤 순환):

```markdown
### {색상이모지} MAI{PROJECT_NAME} ({PROJECT_DESC}) → [[{NN}.MAI{PROJECT_NAME}/_DASHBOARD|대시보드]]

- [ ] 프로젝트 PRD 작성 📅 ⏫ → [[{NN}.MAI{PROJECT_NAME}/_DASHBOARD|MAI{PROJECT_NAME}]]
- [ ] 기술 설계 문서 작성 → [[{NN}.MAI{PROJECT_NAME}/_DASHBOARD|MAI{PROJECT_NAME}]]
- [ ] MVP 개발 착수 → [[{NN}.MAI{PROJECT_NAME}/_DASHBOARD|MAI{PROJECT_NAME}]]
```

초기 태스크는 최소 3개 이상. 프로젝트 성격에 맞는 구체적 태스크로 작성.

#### 6.3 \_MASTER_DASHBOARD.md 동기화

파일: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT\_MASTER_DASHBOARD.md`

Active Projects 테이블에 새 행 추가:

```markdown
| {NN} | [[{NN}.MAI{PROJECT_NAME}/_DASHBOARD|MAI{PROJECT_NAME}]] | :green_circle: Active | `C:\TEST\MAI{PROJECT_NAME}` | [jini92/MAI{PROJECT_NAME}](https://github.com/jini92/MAI{PROJECT_NAME}) | {today} |
```

### 7. Obsidian Kanban 보드 초기화

파일: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT\{NN}.MAI{PROJECT_NAME}\KANBAN.md`

Obsidian Kanban 플러그인 형식으로 초기 칸반 보드 생성:

```markdown
---
kanban-plugin: basic
new-note-template: TEMPLATES/Kanban_Unified.md
new-note-folder: 01.PROJECT/{NN}.MAI{PROJECT_NAME}
---

## 📋 Backlog

## 🔥 Sprint 1

- [ ] 프로젝트 환경 셋업 #setup ⏫
- [ ] PRD 작성 #docs ⏫
- [ ] 기술 설계 #docs 🔼

## 🔄 In Progress

- [ ] 프로젝트 초기화 #setup ⏫

## ✅ Done

%% kanban:settings
{"kanban-plugin":"basic","list-collapse":[false,false,false,false]}
%%
```

- 프로젝트 성격에 맞게 Sprint 1 태스크를 구체화 (최소 5개)
- "프로젝트 초기화"는 In Progress에 배치
- 칸반 컬럼은 최소 4개: Backlog, Sprint 1, In Progress, Done
- 프로젝트 규모에 따라 Sprint 2~4 컬럼 추가 가능
- 카드 태그 규칙: `#feature` (새 기능), `#bug` (버그), `#task` (작업) + 도메인 태그 (#api, #ai, #infra 등)

### 7.1 Kanban 통합 템플릿

칸반 카드 생성 시 `TEMPLATES/Kanban_Unified.md` 통합 템플릿이 적용됨.

- Feature/Bug/Task 구분은 카드 frontmatter의 `tags:` 필드로 지정
- `new-note-folder`는 프로젝트 폴더를 지정: `01.PROJECT/{NN}.MAI{PROJECT_NAME}`

### 7.2 파일 인코딩 주의사항

**PowerShell에서 KANBAN.md 수정 시 반드시 UTF-8 인코딩 유지:**

```powershell
# ✅ 올바른 방법
[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)

# ❌ 사용 금지 (한글 깨짐)
Set-Content $path -Value $content
```

`Set-Content`는 기본 ANSI(CP949) 인코딩으로 쓰므로 UTF-8 한글이 비가역적으로 손실됨.

## 문서 생성 규칙 (전 프로젝트 공통)

**모든 프로젝트 문서는 반드시 `C:\TEST\MAI{PROJECT_NAME}\docs\` 폴더에 생성한다.**

- ✅ `C:\TEST\MAITOK\docs\A001-PRD.md`
- ❌ `C:\TEST\MAITOK\A001-PRD.md` (상위 폴더 금지)
- ❌ Obsidian 폴더에 직접 생성 금지 (심링크로 자동 반영됨)

Obsidian 프로젝트 폴더(`01.PROJECT/{NN}.MAI{PROJECT_NAME}/`)에 직접 생성 가능한 파일:

- `_DASHBOARD.md` — 프로젝트 대시보드
- `KANBAN.md` — 칸반 보드
- 그 외 Obsidian 전용 메모 (docs 규칙 외)

프로젝트 문서(A/D/I/T 접두사)는 **항상 docs/ 폴더**에 → 심링크를 통해 Obsidian에서 자동 접근.

### 8. MAI-Universe.md 업데이트

파일: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT\MAI-Universe.md`

새 프로젝트를 생태계 문서에 반영:

1. **세계관 다이어그램** — 적절한 위치에 새 프로젝트 추가 (코어/BOT Suite/사업 중 해당 카테고리)
2. **역할 테이블** — 해당 카테고리 테이블에 행 추가 (역할, 비유, 수익 모델)
3. **시너지 맵** — 기존 프로젝트와의 연결 관계 분석 + 추가
4. **수익 구조** — 해당 수익 테이블에 행 추가
5. **타임라인** — 시작 시점 표기

BOT Suite 편입 대상이면 BOT 이름도 함께 결정 (BOT + 키워드 패턴).

## Post-Setup

Confirm all 8 steps completed and share summary to Discord DM.
Summary should include:

- 로컬 경로
- GitHub URL
- Obsidian 폴더 번호
- 칸반 보드 위치
- Dashboard 등록 확인
- MAI-Universe.md 업데이트 확인
