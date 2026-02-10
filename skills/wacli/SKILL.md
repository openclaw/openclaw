---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI (not for normal user chats).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://wacli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📱",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["wacli"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/wacli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["wacli"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install wacli (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/steipete/wacli/cmd/wacli@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["wacli"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install wacli (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `wacli` only when the user explicitly asks you to message someone else on WhatsApp or when they ask to sync/search WhatsApp history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do NOT use `wacli` for normal user chats; OpenClaw routes WhatsApp conversations automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the user is chatting with you on WhatsApp, you should not reach for this tool unless they ask you to contact a third party.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Require explicit recipient + message text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm recipient + message before sending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If anything is ambiguous, ask a clarifying question.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth + sync（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli auth` (QR login + initial sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli sync --follow` (continuous sync)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli doctor`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Find chats + messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli chats list --limit 20 --query "name or number"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli messages search "query" --limit 20 --chat <jid>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli messages search "invoice" --after 2025-01-01 --before 2025-12-31`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
History backfill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli history backfill --chat <jid> --requests 2 --count 50`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Text: `wacli send text --to "+14155551212" --message "Hello! Are you free at 3pm?"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group: `wacli send text --to "1234567890-123456789@g.us" --message "Running 5 min late."`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File: `wacli send file --to "+14155551212" --file /path/agenda.pdf --caption "Agenda"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Store dir: `~/.wacli` (override with `--store`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--json` for machine-readable output when parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Backfill requires your phone online; results are best-effort.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp CLI is not needed for routine user chats; it’s for messaging other people.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JIDs: direct chats look like `<number>@s.whatsapp.net`; groups look like `<id>@g.us` (use `wacli chats list` to find).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
