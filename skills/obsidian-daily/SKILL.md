---
name: obsidian-daily
description: Create and manage Obsidian daily notes. Use when asked to write daily notes, record today's work, log session activities, or create daily summaries. Triggers on keywords like "daily note", "today's log", "write daily", "daily summary".
---

# Obsidian Daily Note

## Configuration

Set these to match your vault:

- **Base path**: path to your `DAILY` folder inside the vault
- **Sync**: adjust if using OneDrive / iCloud / Obsidian Sync

## File Naming

```
YYYY-MM-DD_short-summary.md
```

Examples:

- `2026-02-18_fix-env-gsudo-chrome.md`
- `2026-02-19_maibotalks-app-submit.md`

The title should briefly summarize the day's main activities.

## Template

```markdown
# YYYY-MM-DD (Day) — Daily Note

## Completed Today

### [Category]

- **Task** → Result
  - Details

## Tomorrow's Actions

- [ ] Action 1
- [ ] Action 2
```

Category emoji prefixes: 🔧 Dev, 📱 Mobile, 🚀 Deploy, 🔗 Integration, 📝 Docs, 💡 Ideas, 📋 Planning

## Encoding

**CRITICAL on Windows**: Never use `Set-Content`. Always use:

```powershell
[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)
```

## Workflow

1. Collect today's activities from session context
2. Group by category
3. Generate filename with descriptive title
4. Write using UTF-8 encoding
5. Include tomorrow's action items from pending tasks

## Vault Structure (PARA)

- `00.DAILY/` — daily notes
- `01.PROJECT/` — project dashboards and kanban
- `02.AREA/` — ongoing areas of interest
- `03.RESOURCES/` — reference material
- `04.ARCHIVE/` — archived notes

Project docs live in `PROJECT_ROOT/docs/` with A/D/I/T prefixes (Analysis / Design / Implementation / Test).
