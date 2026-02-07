---
name: obsidian-sync
description: Obsidian 대시보드, Kanban 보드, 서브 리포 메모리 동기화를 관리하는 스킬. 수동 실행, 상태 확인, hook 설치를 지원한다.
---

# Obsidian Sync Skill

MAIBOT의 memory 파일을 Obsidian vault로 동기화하는 전체 파이프라인을 관리한다.

## Architecture

```
서브 리포 (MAIOSS/MAIBEAUTY) commit
  → post-commit hook
  → sync-subrepo-to-memory.ts (memory 파일 업데이트)
  → MAIBOT auto-commit + push
  → MAIBOT post-commit hook
  → sync-obsidian-dashboards.ts
  → Obsidian vault 파일 갱신
    ├── _DASHBOARD.md (마커 기반 섹션 업데이트)
    └── _KANBAN.md (전체 파일 덮어쓰기)
```

## Available Commands

### 1. Full Sync (전체 동기화)

수동으로 모든 대시보드와 Kanban을 동기화한다.

```bash
node --import tsx scripts/sync-obsidian-dashboards.ts
```

특정 memory 파일만:
```bash
node --import tsx scripts/sync-obsidian-dashboards.ts memory/maioss.md
node --import tsx scripts/sync-obsidian-dashboards.ts memory/vietnam-beauty.md
```

### 2. Sub-repo Sync (서브 리포 → MAIBOT memory)

서브 리포의 최근 커밋을 MAIBOT memory에 반영하고 auto-commit + push한다.

```bash
node --import tsx scripts/sync-subrepo-to-memory.ts maioss
node --import tsx scripts/sync-subrepo-to-memory.ts maibeauty
```

### 3. Hook Installation (hook 설치/재설치)

MAIOSS와 MAIBEAUTY에 post-commit hook을 설치한다. 기존 hook에 append하며, 마커 기반으로 재실행 시 업데이트한다.

```bash
bash scripts/install-subrepo-hooks.sh
```

### 4. Status Check (상태 확인)

동기화 상태를 확인할 때 아래 항목을 점검한다:

1. **Vault 경로 확인**: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT`
2. **Kanban 플러그인**: `.obsidian/plugins/obsidian-kanban/` 존재 여부
3. **Hook 설치 상태**: 각 서브 리포의 `.git/hooks/post-commit`에 MAIBOT-SYNC 마커 존재 여부
4. **파일 타임스탬프**: `_DASHBOARD.md`, `_KANBAN.md` 최종 수정 시간

## File Map

| 스크립트 | 용도 |
|----------|------|
| `scripts/sync-obsidian-dashboards.ts` | memory → Obsidian 대시보드 + Kanban 동기화 |
| `scripts/sync-subrepo-to-memory.ts` | 서브 리포 커밋 → MAIBOT memory 업데이트 + auto-commit + push |
| `scripts/install-subrepo-hooks.sh` | 서브 리포에 post-commit hook 설치 |
| `git-hooks/post-commit` | MAIBOT post-commit hook (memory 변경 시 Obsidian sync 실행) |

## Obsidian Vault Structure

| Vault 경로 | 소스 | 업데이트 방식 |
|-------------|------|---------------|
| `_MASTER_DASHBOARD.md` | `MEMORY.md` | 마커 기반 섹션 |
| `00.MAIBOT/_DASHBOARD.md` | git log | 마커 기반 (recent-commits) |
| `04.MAIOSS/_DASHBOARD.md` | `memory/maioss.md` | 마커 기반 (4 섹션) |
| `04.MAIOSS/_KANBAN.md` | `memory/maioss.md` | 전체 덮어쓰기 |
| `07.MAIBEAUTY/_DASHBOARD.md` | `memory/vietnam-beauty.md` | 마커 기반 (4 섹션) |
| `07.MAIBEAUTY/_KANBAN.md` | `memory/vietnam-beauty.md` | 전체 덮어쓰기 |

## Kanban Column Mapping

### MAIOSS
| 컬럼 | 소스 |
|------|------|
| ✅ Done | `### ✅` 완료 마일스톤 (최근 5개) |
| 📋 Todo | `기존 과제` 섹션 `- [ ]` 항목 |
| 🔴 Blocked | "대기/차단/미제공" 패턴 + CAVD API 상태 |

### MAIBEAUTY
| 컬럼 | 소스 |
|------|------|
| ✅ Done | `🔵 완료` 섹션 `- [x]` (최근 5개) |
| 📋 Todo | `🟢 다음 단계` `- [ ]` 항목 |
| 🟡 Waiting (지니) | `🟡 지니 액션 필요` `- [ ]` 항목 |
| 🔴 Blocked | Zalo 관련 차단 패턴 |

## Sub-repo Config

| 프로젝트 | 리포 경로 | Memory 파일 | Kanban |
|----------|----------|-------------|--------|
| MAIOSS | `C:\TEST\MAIOSS` | `memory/maioss.md` | `04.MAIOSS/_KANBAN.md` |
| MAIBEAUTY | `C:\TEST\MAIBEAUTY` | `memory/vietnam-beauty.md` | `07.MAIBEAUTY/_KANBAN.md` |

## Troubleshooting

| 문제 | 원인 | 해결 |
|------|------|------|
| Kanban 플러그인 미설치 | Community Plugin 미활성화 | Obsidian → Settings → Community Plugins → "Kanban" 검색 → Install + Enable |
| hook 미실행 | hook 파일 없음/권한 | `bash scripts/install-subrepo-hooks.sh` 재실행 |
| vault not found | 경로 불일치 | 환경변수 `MAIBOT_OBSIDIAN_VAULT` 설정 또는 `resolveVaultPath()` 수정 |
| push 실패 | 네트워크/충돌 | 다음 커밋 시 자동 재시도, 수동: `git push origin main` |
| memory 파싱 실패 | 섹션 헤딩 변경 | 해당 extractor 함수의 헤딩 문자열 수정 |

## Activation

이 스킬은 아래 요청 시 활성화:
- "Obsidian 동기화", "대시보드 동기화", "Kanban 동기화"
- "sync obsidian", "sync dashboards", "sync kanban"
- "/obsidian-sync"
- hook 설치, 동기화 상태 확인 요청
