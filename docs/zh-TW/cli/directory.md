---
summary: "openclaw directory 的 CLI 參考文件 (self, peers, groups)"
read_when:
  - 當你想查找頻道的聯絡人/群組/自身 ID 時
  - 當你正在開發頻道目錄配接器 (adapter) 時
title: "directory"
---

# `openclaw directory`

針對支援此功能的頻道進行目錄查找（聯絡人/同儕、群組以及「我」）。

## 常用標記

- `--channel <name>`: 頻道 ID/別名（當設定多個頻道時為必填；僅有一個頻道時會自動選取）
- `--account <id>`: 帳號 ID（預設值：頻道預設值）
- `--json`: 輸出 JSON

## 注意事項

- `directory` 旨在協助你查找可以貼上到其他指令中的 ID（特別是 `openclaw message send --target ...`）。
- 對於許多頻道而言，結果是基於設定（白名單 / 已設定的群組），而非即時的供應商目錄。
- 預設輸出為 `id`（有時包含 `name`），並以 tab 分隔；如需編寫腳本請使用 `--json`。

## 搭配 `message send` 使用結果

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 格式（按頻道分類）

- WhatsApp: `+15551234567` (私訊), `1234567890-1234567890 @g.us` (群組)
- Telegram: `@username` 或數字聊天 ID；群組為數字 ID
- Slack: `user:U…` 與 `channel:C…`
- Discord: `user:<id>` 與 `channel:<id>`
- Matrix (外掛程式): `user: @user:server`, `room:!roomId:server`, 或 `#alias:server`
- Microsoft Teams (外掛程式): `user:<id>` 與 `conversation:<id>`
- Zalo (外掛程式): 使用者 ID (Bot API)
- Zalo 個人 / `zalouser` (外掛程式): 來自 `zca` (`me`, `friend list`, `group list`) 的討論串 ID (私訊/群組)

## 自身（「我」）

```bash
openclaw directory self --channel zalouser
```

## 同儕（聯絡人/使用者）

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
