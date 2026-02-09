---
summary: "透過 Gateway 閘道器 + CLI 傳送投票"
read_when:
  - 新增或修改投票支援時
  - 從 CLI 或 Gateway 閘道器 偵錯投票傳送時
title: "投票"
---

# 投票

## 支援的頻道

- WhatsApp（網頁頻道）
- Discord
- MS Teams（Adaptive Cards）

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

選項：

- `--channel`：`whatsapp`（預設）、`discord`，或 `msteams`
- `--poll-multi`：允許選擇多個選項
- `--poll-duration-hours`：僅限 Discord（省略時預設為 24）

## Gateway RPC

方法：`poll`

Params:

- `to`（string，必填）
- `question`（string，必填）
- `options`（string[]，必填）
- `maxSelections`（number，選填）
- `durationHours`（number，選填）
- `channel`（string，選填，預設：`whatsapp`）
- `idempotencyKey`（string，必填）

## 頻道差異

- WhatsApp：2–12 個選項，`maxSelections` 必須在選項數量範圍內，忽略 `durationHours`。
- Discord：2–10 個選項，`durationHours` 會限制在 1–768 小時（預設 24）。`maxSelections > 1` 啟用多選；Discord 不支援嚴格的選擇數量限制。 `maxSelections > 1` enables multi-select; Discord does not support a strict selection count.
- MS Teams：Adaptive Card 投票（由 OpenClaw 管理）。沒有原生投票 API；`durationHours` 會被忽略。 No native poll API; `durationHours` is ignored.

## 代理程式工具（訊息）

使用 `message` 工具搭配 `poll` 動作（`to`、`pollQuestion`、`pollOption`，以及選填的 `pollMulti`、`pollDurationHours`、`channel`）。

Note: Discord has no “pick exactly N” mode; `pollMulti` maps to multi-select.
注意：Discord 沒有「必須選擇恰好 N 個」的模式；`pollMulti` 會對應為多選。
Teams 的投票會以 Adaptive Cards 呈現，且需要 Gateway 閘道器 持續在線，才能在 `~/.openclaw/msteams-polls.json` 中記錄投票結果。
