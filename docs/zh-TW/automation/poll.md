---
summary: "透過 Gateway + CLI 傳送投票"
read_when:
  - 新增或修改投票支援時
  - 從 CLI 或 Gateway 偵錯投票傳送時
title: "投票"
---

# 投票

## 支援的通道

- WhatsApp (網頁通道)
- Discord
- MS Teams (自適應卡片)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789 @g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc @thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

選項：

- `--channel`：`whatsapp` (預設)、`discord` 或 `msteams`
- `--poll-multi`：允許選擇多個選項
- `--poll-duration-hours`：僅限 Discord (省略時預設為 24 小時)

## Gateway RPC

方法：`poll`

參數：

- `to` (字串，必填)
- `question` (字串，必填)
- `options` (字串陣列，必填)
- `maxSelections` (數字，選填)
- `durationHours` (數字，選填)
- `channel` (字串，選填，預設：`whatsapp`)
- `idempotencyKey` (字串，必填)

## 通道差異

- WhatsApp：2-12 個選項，`maxSelections` 必須在選項數量範圍內，忽略 `durationHours`。
- Discord：2-10 個選項，`durationHours` 限制在 1-768 小時 (預設 24)。`maxSelections > 1` 啟用多選；Discord 不支援嚴格的選擇數量。
- MS Teams：自適應卡片投票 (OpenClaw 管理)。無原生投票 API；`durationHours` 被忽略。

## 代理工具 (訊息)

使用 `message` 工具搭配 `poll` 動作 (`to`、`pollQuestion`、`pollOption`，選填 `pollMulti`、`pollDurationHours`、`channel`)。

注意：Discord 沒有「精確選擇 N 個」模式；`pollMulti` 對應到多選。
Teams 投票以自適應卡片呈現，並要求 Gateway 保持線上才能將投票記錄在 `~/.openclaw/msteams-polls.json` 中。
