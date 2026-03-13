---
summary: Retry policy for outbound provider calls
read_when:
  - Updating provider retry behavior or defaults
  - Debugging provider send errors or rate limits
title: Retry Policy
---

# 重試策略

## 目標

- 以 HTTP 請求為單位重試，而非多步驟流程整體重試。
- 透過僅重試當前步驟來維持順序。
- 避免重複執行非冪等操作。

## 預設值

- 嘗試次數：3 次
- 最大延遲上限：30000 毫秒
- 抖動值：0.1（10%）
- 服務提供者預設：
  - Telegram 最小延遲：400 毫秒
  - Discord 最小延遲：500 毫秒

## 行為

### Discord

- 僅在速率限制錯誤（HTTP 429）時重試。
- 有 `retry_after` 時使用，否則採用指數退避。

### Telegram

- 在暫時性錯誤（429、逾時、連線重置/關閉、暫時不可用）時重試。
- 有 `retry_after` 時使用，否則採用指數退避。
- Markdown 解析錯誤不重試，改回退為純文字。

## 設定

在 `~/.openclaw/openclaw.json` 中為各服務提供者設定重試策略：

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

## 備註

- 重試以每個請求為單位（訊息發送、媒體上傳、反應、投票、貼圖）。
- 複合流程不會重試已完成的步驟。
