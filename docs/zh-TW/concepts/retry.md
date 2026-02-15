---
summary: "對外供應商呼叫的重試策略"
read_when:
  - 更新供應商重試行為或預設值
  - 偵錯供應商傳送錯誤或速率限制
title: "重試策略"
---

# 重試策略

## 目標

- 對每個 HTTP 請求進行重試，而非針對多步驟流程。
- 僅重試目前步驟以保留排序。
- 避免重複非冪等操作。

## 預設值

- 嘗試次數：3
- 最大延遲上限：30000 毫秒
- 抖動：0.1 (10%)
- 供應商預設值：
  - Telegram 最小延遲：400 毫秒
  - Discord 最小延遲：500 毫秒

## 行為

### Discord

- 僅在速率限制錯誤 (HTTP 429) 時重試。
- 可用時使用 Discord 的 `retry_after`，否則採用指數退避。

### Telegram

- 在暫時性錯誤 (429、逾時、連線/重設/關閉、暫時無法使用) 時重試。
- 可用時使用 `retry_after`，否則採用指數退避。
- Markdown 解析錯誤不會重試；它們會回退到純文字。

## 設定

在 `~/.openclaw/openclaw.json` 中為每個供應商設定重試策略：

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

- 重試適用於每個請求 (訊息傳送、媒體上傳、反應、投票、貼圖)。
- 複合流程不會重試已完成的步驟。
