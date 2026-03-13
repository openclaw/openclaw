---
summary: Retry policy for outbound provider calls
read_when:
  - Updating provider retry behavior or defaults
  - Debugging provider send errors or rate limits
title: Retry Policy
---

# Retry policy

## 目標

- 每個 HTTP 請求重試，而不是每個多步驟流程重試。
- 透過僅重試當前步驟來保持順序。
- 避免重複執行非冪等操作。

## Defaults

- 嘗試次數: 3
- 最大延遲上限: 30000 毫秒
- 抖動: 0.1 (10 百分比)
- 提供者預設值:
  - Telegram 最小延遲: 400 毫秒
  - Discord 最小延遲: 500 毫秒

## Behavior

### Discord

- 只在速率限制錯誤（HTTP 429）時重試。
- 當可用時使用 Discord `retry_after`，否則使用指數退避。

### Telegram

- 在暫時性錯誤（429、超時、連接/重置/關閉、暫時不可用）上進行重試。
- 當可用時使用 `retry_after`，否則使用指數退避。
- Markdown 解析錯誤不會重試；會回退為純文字。

## Configuration

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

## Notes

- 重試適用於每個請求（訊息發送、媒體上傳、反應、投票、貼圖）。
- 複合流程不會重試已完成的步驟。
