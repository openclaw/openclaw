---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: things-mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Manage Things 3 via the `things` CLI on macOS (add/update projects+todos via URL scheme; read/search/list from the local Things database). Use when a user asks OpenClaw to add a task to Things, list inbox/today/upcoming, search tasks, or inspect projects/areas/tags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/ossianhempel/things3-cli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "✅",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["things"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/ossianhempel/things3-cli/cmd/things@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["things"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install things3-cli (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Things 3 CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `things` to read your local Things database (inbox/today/search/projects/areas/tags) and to add/update todos via the Things URL scheme.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install (recommended, Apple Silicon): `GOBIN=/opt/homebrew/bin go install github.com/ossianhempel/things3-cli/cmd/things@latest`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If DB reads fail: grant **Full Disk Access** to the calling app (Terminal for manual runs; `OpenClaw.app` for gateway runs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional: set `THINGSDB` (or pass `--db`) to point at your `ThingsData-*` folder.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional: set `THINGS_AUTH_TOKEN` to avoid passing `--auth-token` for update ops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read-only (DB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `things inbox --limit 50`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `things today`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `things upcoming`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `things search "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `things projects` / `things areas` / `things tags`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write (URL scheme)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer safe preview: `things --dry-run add "Title"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add: `things add "Title" --notes "..." --when today --deadline 2026-01-02`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bring Things to front: `things --foreground add "Title"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples: add a todo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Basic: `things add "Buy milk"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- With notes: `things add "Buy milk" --notes "2% + bananas"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Into a project/area: `things add "Book flights" --list "Travel"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Into a project heading: `things add "Pack charger" --list "Travel" --heading "Before"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- With tags: `things add "Call dentist" --tags "health,phone"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Checklist: `things add "Trip prep" --checklist-item "Passport" --checklist-item "Tickets"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- From STDIN (multi-line => title + notes):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `cat <<'EOF' | things add -`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `Title line`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `Notes line 1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `Notes line 2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `EOF`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples: modify a todo (needs auth token)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- First: get the ID (UUID column): `things search "milk" --limit 5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: set `THINGS_AUTH_TOKEN` or pass `--auth-token <TOKEN>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Title: `things update --id <UUID> --auth-token <TOKEN> "New title"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notes replace: `things update --id <UUID> --auth-token <TOKEN> --notes "New notes"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notes append/prepend: `things update --id <UUID> --auth-token <TOKEN> --append-notes "..."` / `--prepend-notes "..."`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Move lists: `things update --id <UUID> --auth-token <TOKEN> --list "Travel" --heading "Before"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tags replace/add: `things update --id <UUID> --auth-token <TOKEN> --tags "a,b"` / `things update --id <UUID> --auth-token <TOKEN> --add-tags "a,b"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Complete/cancel (soft-delete-ish): `things update --id <UUID> --auth-token <TOKEN> --completed` / `--canceled`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Safe preview: `things --dry-run update --id <UUID> --auth-token <TOKEN> --completed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delete a todo?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Not supported by `things3-cli` right now (no “delete/move-to-trash” write command; `things trash` is read-only listing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Options: use Things UI to delete/trash, or mark as `--completed` / `--canceled` via `things update`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dry-run` prints the URL and does not open Things.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
