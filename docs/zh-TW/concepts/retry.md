---
summary: "對外提供者呼叫的重試策略"
read_when:
  - 更新提供者的重試行為或預設值時
  - 偵錯提供者傳送錯誤或速率限制時
title: "重試策略"
x-i18n:
  source_path: concepts/retry.md
  source_hash: 55bb261ff567f46c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:41Z
---

# 重試策略

## 目標

- 以每個 HTTP 請求為單位進行重試，而非以多步驟流程為單位。
- 僅重試目前步驟以保留順序。
- 避免重複執行非冪等作業。

## 預設值

- 嘗試次數：3
- 最大延遲上限：30000 ms
- 抖動：0.1（10％）
- 提供者預設值：
  - Telegram 最小延遲：400 ms
  - Discord 最小延遲：500 ms

## 行為

### Discord

- 僅在速率限制錯誤（HTTP 429）時重試。
- 可用時使用 Discord `retry_after`，否則使用指數退避。

### Telegram

- 在暫時性錯誤時重試（429、timeout、connect/reset/closed、temporarily unavailable）。
- 可用時使用 `retry_after`，否則使用指數退避。
- Markdown 解析錯誤不會重試；會回退為純文字。

## 設定

在 `~/.openclaw/openclaw.json` 中為每個提供者設定重試策略：

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## 注意事項

- 重試會套用於每個請求（訊息傳送、媒體上傳、回應、投票、貼圖）。
- 複合流程不會重試已完成的步驟。
