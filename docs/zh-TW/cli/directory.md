```
---
summary: "CLI 參考文件：`openclaw directory` (自身、對等節點、群組)"
read_when:
  - 您想查詢頻道的聯絡人/群組/自身 ID
  - 您正在開發頻道目錄轉接器
title: "directory"
---

# `openclaw directory`

支援目錄查詢的頻道（聯絡人/對等節點、群組和「自身」）的目錄查詢功能。

## 常見旗標

- `--channel <name>`: 頻道 ID/別名（當設定了多個頻道時為必填；當只設定一個頻道時自動填入）
- `--account <id>`: 帳戶 ID（預設：頻道預設值）
- `--json`: 輸出 JSON

## 注意事項

- `directory` 旨在幫助您找到可以貼入其他命令（尤其是 `openclaw message send --target ...`）的 ID。
- 對於許多頻道，結果是透過設定支援的（允許清單/已設定的群組），而非即時的供應商目錄。
- 預設輸出是以 Tab 分隔的 `ID` (有時包含 `name`)；使用 `--json` 進行腳本編寫。

## 將結果與 `message send` 搭配使用

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 格式（依頻道）

- WhatsApp: `+15551234567` (私訊), `1234567890-1234567890 @g.us` (群組)
- Telegram: ` @username` 或數字聊天 ID；群組為數字 ID
- Slack: `user:U…` and `channel:C…`
- Discord: `user:<id>` and `channel:<id>`
- Matrix (外掛): `user: @user:server`, `room:!roomId:server`, or `#alias:server`
- Microsoft Teams (外掛): `user:<id>` and `conversation:<id>`
- Zalo (外掛): 使用者 ID (Bot API)
- Zalo 個人版 / `zalouser` (外掛): 來自 `zca` 的對話 ID (私訊/群組)（`自身`、`好友清單`、`群組清單`）

## 自身（「me」）

```bash
openclaw directory self --channel zalouser
```

## 對等節點（聯絡人/使用者）

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## 群組

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
```
