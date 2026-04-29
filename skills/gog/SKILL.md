---
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
homepage: https://gogcli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/gogcli",
              "bins": ["gog"],
              "label": "Install gog (brew)",
            },
          ],
      },
  }
---

# gog

使用 `gog` 处理 Gmail/Calendar/Drive/Contacts/Sheets/Docs。需要 OAuth 设置。

设置（一次）

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

常用命令

- Gmail 搜索：`gog gmail search 'newer_than:7d' --max 10`
- Gmail 消息搜索（每封邮件，忽略线程）：`gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail 发送（纯文本）：`gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail 发送（多行）：`gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail 发送（stdin）：`gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail 发送（HTML）：`gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail 草稿：`gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail 发送草稿：`gog gmail drafts send <draftId>`
- Gmail 回复：`gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Calendar 列出事件：`gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar 创建事件：`gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Calendar 带颜色创建：`gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar 更新事件：`gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Calendar 显示颜色：`gog calendar colors`
- Drive 搜索：`gog drive search "query" --max 10`
- Contacts：`gog contacts list --max 20`
- Sheets 获取：`gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets 更新：`gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets 追加：`gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets 清除：`gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets 元数据：`gog sheets metadata <sheetId> --json`
- Docs 导出：`gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat：`gog docs cat <docId>`

日历颜色

- 使用 `gog calendar colors` 查看所有可用事件颜色（ID 1-11）
- 使用 `--event-color <id>` 标志为事件添加颜色
- 事件颜色 ID（来自 `gog calendar colors` 输出）：
  - 1: #a4bdfc
  - 2: #7ae7bf
  - 3: #dbadff
  - 4: #ff887c
  - 5: #fbd75b
  - 6: #ffb878
  - 7: #46d6db
  - 8: #e1e1e1
  - 9: #5484ed
  - 10: #51b749
  - 11: #dc2127

电子邮件格式

- 优先使用纯文本。多段落消息使用 `--body-file`（或 `--body-file -` 用于 stdin）。
- 相同的 `--body-file` 模式适用于草稿和回复。
- `--body` 不会取消转义 `\n`。如果需要内联换行符，使用 heredoc 或 `$'Line 1\n\nLine 2'`。
- 仅在需要富格式时使用 `--body-html`。
- HTML 标签：`<p>` 用于段落，`<br>` 用于换行，`<strong>` 用于粗体，`<em>` 用于斜体，`<a href="url">` 用于链接，`<ul>`/`<li>` 用于列表。
- 示例（通过 stdin 的纯文本）：

  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-file - <<'EOF'
  Hi Name,

  Thanks for meeting today. Next steps:
  - Item one
  - Item two

  Best regards,
  Your Name
  EOF
  ```

- 示例（HTML 列表）：
  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-html "<p>Hi Name,</p><p>Thanks for meeting today. Here are the next steps:</p><ul><li>Item one</li><li>Item two</li></ul><p>Best regards,<br>Your Name</p>"
  ```

提示

- 设置 `GOG_ACCOUNT=you@gmail.com` 以避免重复 `--account`。
- 对于脚本处理，优先使用 `--json` 加 `--no-input`。
- Sheets 值可以通过 `--values-json`（推荐）或内联行传递。
- Docs 支持 export/cat/copy原地编辑需要一个 Docs API 客户端（不在 gog 中）。
- 发送邮件或创建事件前确认。
- `gog gmail search` 每个线程返回一行；当您需要每个单独的电子邮件分别返回时使用 `gog gmail messages search`。
