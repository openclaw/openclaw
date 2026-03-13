---
summary: "CLI reference for `openclaw directory` (self, peers, groups)"
read_when:
  - You want to look up contacts/groups/self ids for a channel
  - You are developing a channel directory adapter
title: directory
---

# `openclaw directory`

支援的頻道目錄查詢（聯絡人/對等、群組和「我」）。

## Common flags

- `--channel <name>`: 頻道 ID/別名（當設定多個頻道時為必填；當僅設定一個時自動填入）
- `--account <id>`: 帳戶 ID（預設：頻道預設）
- `--json`: 輸出 JSON

## Notes

- `directory` 旨在幫助您找到可以粘貼到其他命令中的 ID（特別是 `openclaw message send --target ...`）。
- 對於許多頻道，結果是基於設定的（允許清單 / 設定的群組），而不是即時提供者目錄。
- 預設輸出為 `id`（有時為 `name`），以制表符分隔；使用 `--json` 進行腳本編寫。

## 使用 `message send` 的結果

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID 格式（按通道）

- WhatsApp: `+15551234567` (私訊), `1234567890-1234567890@g.us` (群組)
- Telegram: `@username` 或數字聊天 ID；群組為數字 ID
- Slack: `user:U…` 和 `channel:C…`
- Discord: `user:<id>` 和 `channel:<id>`
- Matrix (插件): `user:@user:server`, `room:!roomId:server`, 或 `#alias:server`
- Microsoft Teams (插件): `user:<id>` 和 `conversation:<id>`
- Zalo (插件): 使用者 ID (Bot API)
- Zalo 個人 / `zalouser` (插件): 來自 `zca` 的線程 ID (私訊/群組) (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (聯絡人/用戶)

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
