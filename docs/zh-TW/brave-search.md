---
summary: "web_search 的 Brave Search API 設定"
read_when:
  - 你想將 Brave Search 用於 web_search
  - 你需要 BRAVE_API_KEY 或方案詳情
title: "Brave Search"
---

# Brave Search API

OpenClaw 使用 Brave Search 作為 web_search 的預設供應商。

## 取得 API 金鑰

1. 前往 [https://brave.com/search/api/](https://brave.com/search/api/) 建立 Brave Search API 帳號
2. 在控制台中，選擇 **Data for Search** 方案並產生 API 金鑰。
3. 將金鑰儲存在設定（建議做法）或在 Gateway 環境中設定 `BRAVE_API_KEY`。

## 設定範例

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

## 注意事項

- Data for AI 方案與 `web_search` **不**相容。
- Brave 提供免費層級以及付費方案；請查看 Brave API 入口網站以了解目前的限制。

請參閱 [Web 工具](/tools/web) 了解完整的 web_search 設定。
