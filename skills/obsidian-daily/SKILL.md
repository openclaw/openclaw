---
name: obsidian-daily
description: Create and manage Obsidian daily notes. Use when asked to write daily notes, record today's work, log session activities, or create daily summaries. Triggers on keywords like "데일리 노트", "오늘 기록", "일일 노트", "daily note".
---

# Obsidian Daily Note

## Configuration

- **Base path**: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\00.DAILY\`
- **Sync**: OneDrive → iPad Obsidian (real-time)

## File Naming

```
YYYY-MM-DD_핵심내용.md
```

Examples:

- `2026-02-18_환경설정(gsudo, Chrome Debug).md`
- `2026-02-19_MAIBOTALKS 앱스토어 제출.md`

Title should summarize the day's main activities in Korean, concise and scannable.

## Template

```markdown
# YYYY-MM-DD (요일) 데일리 노트

## 오늘 한 일

### 카테고리 (이모지)

- **작업명** — 설명
  - 세부사항

## 내일 할 일

- [ ] 할 일 1
- [ ] 할 일 2
```

Categories use emoji prefixes: 🔧 환경설정, 💻 개발, 📋 점검, 🐛 버그수정, 📝 문서, 🚀 배포, 💡 기획

## Encoding

**CRITICAL**: Never use `Set-Content`. Always use:

```powershell
[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)
```

## Workflow

1. Collect today's activities from session context
2. Group by category
3. Generate filename with descriptive title
4. Write using UTF-8 encoding
5. Include tomorrow's action items from pending tasks

## Obsidian Vault Rules

- Vault: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\`
- Structure: PARA-based (`00.DAILY`, `01.PROJECT`, `02.AREA`, `03.RESOURCES`, `04.ARCHIVE`)
- Project docs: `C:\TEST\MAI{NAME}\docs\` (A/D/I/T-prefixed files)
- Obsidian project folder (`01.PROJECT/NN.MAI{NAME}/`): only `_DASHBOARD.md` and `KANBAN.md` directly; docs via symlink
- New projects: always under `01.PROJECT/XX.프로젝트명/`
