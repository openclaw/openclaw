---
name: mai-project-init
description: "Initialize a new MAI project: local workspace (C:\\TEST\\), Obsidian folder, GitHub private repo, and MAIBOT memory registration. Use when 지니 says '새 프로젝트', '프로젝트 만들어', '프로젝트 세팅', 'new MAI project', or sets up a MAI-prefixed project. NOT for: existing project config changes, non-MAI projects."
---

# MAI Project Init

New MAI project setup — 9 steps, fully automated.

## Required Input

| Input          | Required | Example               |
| -------------- | -------- | --------------------- |
| `PROJECT_NAME` | ✅       | `CON` → MAICON        |
| `PROJECT_DESC` | ✅       | "AI 로컬 서비스 예약" |
| `BRAND_NAME`   | ❌       | "Tikly"               |

## Steps Overview

| #   | Step                | What                                                         | Key Output                      |
| --- | ------------------- | ------------------------------------------------------------ | ------------------------------- |
| 1   | Local Workspace     | `C:\TEST\MAI{NAME}\` 생성                                    | `.gitignore`, `README.md`       |
| 2   | Docs Folder         | `docs/` + Obsidian `_DASHBOARD.md`                           | 문서 명명 규칙 (A/D/I/T 접두사) |
| 3   | Obsidian Folder     | `01.PROJECT/{NN}.MAI{NAME}/` + docs symlink                  | 순번 자동 결정                  |
| 4   | GitHub Repo         | `jini92/MAI{NAME}` private repo                              | `gh repo create --private`      |
| 5   | Memory Registration | `memory/mai{name}.md` + `MEMORY.md` 업데이트                 | 프로젝트 기록                   |
| 6   | Dashboard 등록      | `Dashboard.md` 테이블 + 태스크 섹션 + `_MASTER_DASHBOARD.md` | Obsidian 통합                   |
| 7   | Kanban Board        | `KANBAN.md` 칸반 플러그인 형식                               | 최소 4컬럼, Sprint 태스크 5개+  |
| 8   | MAI-Universe.md     | 생태계 문서 반영 (다이어그램/역할/시너지/수익/타임라인)      | BOT Suite 편입 검토             |
| 9   | Regression Guard    | `benchmarks/baseline.json` scaffold + `CLAUDE.md` 섹션       | 파이프라인 구현 후 채움         |

## Key Rules

1. **문서 경로**: 모든 프로젝트 문서는 반드시 `C:\TEST\MAI{NAME}\docs\`에 생성 (심링크로 Obsidian 자동 반영)
2. **문서 명명**: `A000`(분석), `D000`(설계), `I000`(구현), `T000`(테스트) 접두사
3. **파일 인코딩**: PowerShell에서 `[System.IO.File]::WriteAllText()` 사용 (UTF-8). `Set-Content` 사용 금지 (한글 깨짐)
4. **Obsidian 직접 생성 허용**: `_DASHBOARD.md`, `KANBAN.md`, Obsidian 전용 메모만
5. **Symlink**: `New-Item -ItemType SymbolicLink` (elevated or developer mode 필요)
6. **Git stash 금지**: 멀티에이전트 안전 — 커밋 안 된 변경은 먼저 커밋
7. **Regression Guard**: 초기화 시 scaffold만 생성. 파이프라인 완성 후 `regression-guard` 스킬로 실제 메트릭 채움

## Post-Setup

9단계 완료 후 Discord DM(channel:1466624220632059934)에 요약 보고:
로컬 경로, GitHub URL, Obsidian 폴더 번호, 칸반 보드 위치, Dashboard 등록, MAI-Universe.md 업데이트, `benchmarks/baseline.json` 생성 확인.

## Detailed Steps

See [references/steps.md](references/steps.md) for full commands and templates.
