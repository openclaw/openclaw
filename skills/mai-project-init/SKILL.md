---
name: mai-project-init
description: Initialize a new MAI project with local workspace, Obsidian folder, GitHub repo, and MAIBOT memory registration. Use when 지니 says "새 프로젝트", "프로젝트 만들어", "프로젝트 세팅", or asks to set up a new MAI-prefixed project.
---

# MAI Project Init

New MAI project setup — 5 steps, fully automated.

## Required Input

- `PROJECT_NAME`: short name without "MAI" prefix (e.g., "CON" → MAICON)

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

## Post-Setup

Confirm all 5 steps completed and share summary to Discord DM.
