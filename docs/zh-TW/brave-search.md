---
summary: Brave Search API setup for web_search
read_when:
  - You want to use Brave Search for web_search
  - You need a BRAVE_API_KEY or plan details
title: Brave Search
---

# Brave Search API

OpenClaw 支援 Brave Search API 作為 `web_search` 提供者。

## 獲取 API 金鑰

1. 在 [https://brave.com/search/api/](https://brave.com/search/api/) 創建一個 Brave Search API 帳戶。
2. 在儀表板中，選擇 **Search** 計畫並生成一個 API 金鑰。
3. 將金鑰儲存在設定中或在 Gateway 環境中設置 `BRAVE_API_KEY`。

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Tool parameters

| 參數          | 描述                                                      |
| ------------- | --------------------------------------------------------- |
| `query`       | 搜尋查詢（必填）                                          |
| `count`       | 要返回的結果數量（1-10，預設：5）                         |
| `country`     | 2 字母 ISO 國家程式碼（例如："US"、"DE"）                 |
| `language`    | 搜尋結果的 ISO 639-1 語言程式碼（例如："en"、"de"、"fr"） |
| `ui_lang`     | UI 元素的 ISO 語言程式碼                                  |
| `freshness`   | 時間篩選：`day`（24 小時）、`week`、`month` 或 `year`     |
| `date_after`  | 只返回此日期之後發佈的結果（YYYY-MM-DD）                  |
| `date_before` | 只返回此日期之前發佈的結果（YYYY-MM-DD）                  |

**範例：**

javascript
// 國家和語言特定的搜尋
await web_search({
query: "可再生能源",
country: "DE",
language: "de",
});

// 最近的結果（過去一週）
await web_search({
query: "AI 新聞",
freshness: "week",
});

// 日期範圍搜尋
await web_search({
query: "AI 發展",
date_after: "2024-01-01",
date_before: "2024-06-30",
});

## Notes

- OpenClaw 使用 Brave **Search** 計畫。如果您擁有舊版訂閱（例如，原始的免費計畫，每月 2,000 次查詢），則仍然有效，但不包括 LLM Context 或更高的速率限制等新功能。
- 每個 Brave 計畫包括 **每月 $5 的免費信用額度**（自動續訂）。Search 計畫的費用為每 1,000 次請求 $5，因此該信用額度可涵蓋每月 1,000 次查詢。請在 Brave 儀表板中設置您的使用限制，以避免意外收費。請參閱 [Brave API portal](https://brave.com/search/api/) 獲取當前計畫。
- Search 計畫包括 LLM Context 端點和 AI 推理權限。儲存結果以訓練或調整模型需要具有明確儲存權限的計畫。請參閱 Brave [服務條款](https://api-dashboard.search.brave.com/terms-of-service)。
- 預設情況下，結果會快取 15 分鐘（可通過 `cacheTtlMinutes` 進行設定）。

請參閱 [Web tools](/tools/web) 以獲取完整的 web_search 設定。
