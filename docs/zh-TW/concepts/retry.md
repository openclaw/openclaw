---
summary: "針對外向供應商呼叫的重試策略"
read_when:
  - 更新供應商重試行為或預設值時
  - 除錯供應商發送錯誤或速率限制時
title: "重試策略"
---

# 重試策略

## 目標

- 針對個別 HTTP 請求進行重試，而非針對多步驟流程。
- 僅重試目前步驟以確保順序正確。
- 避免重複進行非等冪（non-idempotent）的操作。

## 預設值

- 嘗試次數：3
- 最大延遲上限：30000 毫秒
- 抖動 (Jitter)：0.1 (10%)
- 供應商預設值：
  - Telegram 最小延遲：400 毫秒
  - Discord 最小延遲：500 毫秒

## 行為規則

### Discord

- 僅在速率限制錯誤 (HTTP 429) 時進行重試。
- 優先使用 Discord 提供之 `retry_after` 資訊（若可用），否則使用指數退避 (exponential backoff)。

### Telegram

- 在暫時性錯誤（429、逾時、連線/重設/關閉、暫時無法使用）時進行重試。
- 優先使用 `retry_after` 資訊（若可用），否則使用指數退避 (exponential backoff)。
- Markdown 解析錯誤不會重試；這類錯誤會退回使用純文字模式發送。

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

- 重試適用於單次請求（訊息發送、媒體上傳、回應 (reaction)、投票、貼圖）。
- 複合流程不會重試已完成的步驟。
