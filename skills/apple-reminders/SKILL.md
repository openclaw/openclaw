---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: apple-reminders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Manage Apple Reminders via the `remindctl` CLI on macOS (list, add, edit, complete, delete). Supports lists, date filters, and JSON/plain output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/steipete/remindctl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "⏰",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["remindctl"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/remindctl",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["remindctl"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install remindctl via Homebrew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Apple Reminders CLI (remindctl)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `remindctl` to manage Apple Reminders directly from the terminal. It supports list filtering, date-based views, and scripting output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install (Homebrew): `brew install steipete/tap/remindctl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- From source: `pnpm install && pnpm build` (binary at `./bin/remindctl`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS-only; grant Reminders permission when prompted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check status: `remindctl status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Request access: `remindctl authorize`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
View Reminders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default (today): `remindctl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Today: `remindctl today`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tomorrow: `remindctl tomorrow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Week: `remindctl week`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overdue: `remindctl overdue`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Upcoming: `remindctl upcoming`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Completed: `remindctl completed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All: `remindctl all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Specific date: `remindctl 2026-01-04`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage Lists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List all lists: `remindctl list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Show list: `remindctl list Work`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create list: `remindctl list Projects --create`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rename list: `remindctl list Work --rename Office`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delete list: `remindctl list Work --delete`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create Reminders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quick add: `remindctl add "Buy milk"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- With list + due: `remindctl add --title "Call mom" --list Personal --due tomorrow`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit Reminders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Edit title/due: `remindctl edit 1 --title "New title" --due 2026-01-04`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Complete Reminders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Complete by id: `remindctl complete 1 2 3`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delete Reminders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delete by id: `remindctl delete 4A83 --force`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Output Formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSON (scripting): `remindctl today --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plain TSV: `remindctl today --plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Counts only: `remindctl today --quiet`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Date Formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accepted by `--due` and date filters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `today`, `tomorrow`, `yesterday`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `YYYY-MM-DD`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `YYYY-MM-DD HH:mm`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ISO 8601 (`2026-01-04T12:34:56Z`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If access is denied, enable Terminal/remindctl in System Settings → Privacy & Security → Reminders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If running over SSH, grant access on the Mac that runs the command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
