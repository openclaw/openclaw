---
name: obsidian-daily
description: "Create and manage Obsidian daily notes with session activity summaries. Use when writing daily notes, recording today's work, logging session activities, creating daily summaries, or reviewing what was done today. Triggers: 'daily note', '데일리 노트', 'Obsidian 일지', '오늘 일지', 'today log', 'write daily', 'daily summary', '오늘 뭐 했는지 정리', '일일 노트'. NOT for: project-specific docs (use obsidian skill), weekly/monthly reviews, general Obsidian vault operations."
---

# Obsidian Daily Note

Create daily notes summarizing session activities in the Obsidian vault.

## Quick Reference

- **Location**: `00.DAILY/` folder in vault
- **Filename**: `YYYY-MM-DD_short-summary.md`
- **Encoding**: UTF-8 via `[System.IO.File]::WriteAllText()` (never `Set-Content`)
- **Write method**: Use `exec` + PowerShell (vault is outside MAIBOT workspace)

## Workflow

1. Collect today's activities from session context
2. Group by category (🔧 Dev, 📱 Mobile, 🚀 Deploy, 🔗 Integration, 📝 Docs, 💡 Ideas, 📋 Planning)
3. Generate filename: `YYYY-MM-DD_descriptive-slug.md`
4. Write using UTF-8 encoding (see references for Windows encoding details)
5. Include tomorrow's action items from pending tasks

## Template

```markdown
# YYYY-MM-DD (Day) — Daily Note

## Completed Today

### [Category Emoji] Category

- **Task** → Result
  - Details

## Tomorrow's Actions

- [ ] Action 1
- [ ] Action 2
```

## Critical: Windows Encoding

```powershell
# ALWAYS use this — never Set-Content
[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)
```

## References

- `references/vault-structure.md` — PARA vault structure and project doc conventions
- `references/daily-examples.md` — filename and content examples
