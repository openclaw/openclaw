---
summary: Poll sending via gateway + CLI
read_when:
  - Adding or modifying poll support
  - Debugging poll sends from the CLI or gateway
title: Polls
---

# Polls

## 支援的通道

- Telegram
- WhatsApp (網頁通道)
- Discord
- MS Teams (自適應卡片)

## CLI

bash

# Telegram

openclaw message poll --channel telegram --target 123456789 \
 --poll-question "發送嗎？" --poll-option "是" --poll-option "否"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
 --poll-question "選擇一個時間" --poll-option "上午10點" --poll-option "下午2點" \
 --poll-duration-seconds 300

# WhatsApp

openclaw message poll --target +15555550123 \
 --poll-question "今天午餐？" --poll-option "是" --poll-option "否" --poll-option "可能"  
openclaw message poll --target 123456789@g.us \
 --poll-question "會議時間？" --poll-option "上午10點" --poll-option "下午2點" --poll-option "下午4點" --poll-multi

# Discord

openclaw message poll --channel discord --target channel:123456789 \
 --poll-question "小吃？" --poll-option "比薩" --poll-option "壽司"
openclaw message poll --channel discord --target channel:123456789 \
 --poll-question "計畫？" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams

openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
 --poll-question "午餐？" --poll-option "比薩" --poll-option "壽司"

[[BLOCK_1]]

- `--channel`: `whatsapp`（預設）、`telegram`、`discord` 或 `msteams`
- `--poll-multi`: 允許選擇多個選項
- `--poll-duration-hours`: 僅限 Discord（省略時預設為 24）
- `--poll-duration-seconds`: 僅限 Telegram（5-600 秒）
- `--poll-anonymous` / `--poll-public`: 僅限 Telegram 的投票可見性

## Gateway RPC

`poll`

Params:

- `to` (字串，必填)
- `question` (字串，必填)
- `options` (字串陣列，必填)
- `maxSelections` (數字，選填)
- `durationHours` (數字，選填)
- `durationSeconds` (數字，選填，僅限 Telegram)
- `isAnonymous` (布林值，選填，僅限 Telegram)
- `channel` (字串，選填，預設值: `whatsapp`)
- `idempotencyKey` (字串，必填)

## Channel differences

- Telegram: 2-10 選項。透過 `threadId` 或 `:topic:` 目標支援論壇主題。使用 `durationSeconds` 取代 `durationHours`，限制在 5-600 秒內。支援匿名和公開投票。
- WhatsApp: 2-12 選項，`maxSelections` 必須在選項數量內，忽略 `durationHours`。
- Discord: 2-10 選項，`durationHours` 限制在 1-768 小時（預設為 24 小時）。`maxSelections > 1` 啟用多選；Discord 不支援嚴格的選擇數量。
- MS Teams: 自適應卡片投票（由 OpenClaw 管理）。沒有原生的投票 API；`durationHours` 被忽略。

## Agent tool (Message)

使用 `message` 工具搭配 `poll` 動作 (`to`, `pollQuestion`, `pollOption`, 可選的 `pollMulti`, `pollDurationHours`, `channel`).

對於 Telegram，該工具也接受 `pollDurationSeconds`、`pollAnonymous` 和 `pollPublic`。

使用 `action: "poll"` 來創建投票。傳遞的投票欄位 `action: "send"` 將被拒絕。

注意：Discord 沒有「精確選擇 N」模式；`pollMulti` 對應於多選擇。Teams 投票以自適應卡片的形式呈現，並需要網關保持在線以記錄 `~/.openclaw/msteams-polls.json` 中的投票。
