---
summary: "「openclaw directory」（self、peers、groups）的 CLI 參考文件"
read_when:
  - 當你想查詢某個頻道的聯絡人／群組／self ID
  - 當你正在開發頻道目錄配接器
title: "directory"
---

# `openclaw directory`

為支援此功能的頻道提供目錄查詢（聯絡人／peers、群組，以及「me」）。

## Common flags

- `--channel <name>`：頻道 ID／別名（當設定了多個頻道時為必填；僅設定一個時會自動選取）
- `--account <id>`：帳戶 ID（預設：頻道預設值）
- `--json`：輸出 JSON

## Notes

- `directory` 旨在協助你找到可貼到其他指令中的 ID（特別是 `openclaw message send --target ...`）。
- For many channels, results are config-backed (allowlists / configured groups) rather than a live provider directory.
- 預設輸出為以定位字元分隔的 `id`（有時還包含 `name`）；進行腳本處理時請使用 `--json`。

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats（依頻道）

- WhatsApp：`+15551234567`（DM）、`1234567890-1234567890@g.us`（群組）
- Telegram：`@username` 或數字型聊天 ID；群組為數字 ID
- Slack：`user:U…` 與 `channel:C…`
- Discord：`user:<id>` 與 `channel:<id>`
- Matrix（plugin）：`user:@user:server`、`room:!roomId:server` 或 `#alias:server`
- Microsoft Teams（plugin）：`user:<id>` 與 `conversation:<id>`
- Zalo（plugin）：使用者 ID（Bot API）
- Zalo Personal／`zalouser`（plugin）：來自 `zca` 的執行緒 ID（DM／群組）（`me`、`friend list`、`group list`）

## Self（「me」）

```bash
openclaw directory self --channel zalouser
```

## Peers（聯絡人／使用者）

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
