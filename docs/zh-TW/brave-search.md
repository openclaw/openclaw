---
summary: "用於 web_search 的 Brave Search API 設定"
read_when:
  - 你想要使用 Brave Search 進行 web_search
  - 你需要 BRAVE_API_KEY 或方案詳細資訊
title: "Brave Search"
---

# Brave Search API

OpenClaw 使用 Brave Search 作為 `web_search` 的預設提供者。

## 取得 API 金鑰

1. 在 [https://brave.com/search/api/](https://brave.com/search/api/) 建立 Brave Search API 帳戶
2. 在儀表板中，選擇 **Data for Search** 方案並產生 API 金鑰。
3. 將金鑰儲存在設定中（建議），或在 Gateway 環境中設定 `BRAVE_API_KEY`。

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

- **Data for AI** 方案與 `web_search` **不** 相容。
- Brave 提供免費方案與付費方案；請查看 Brave API 入口網站以取得目前的限制資訊。

請參閱 [Web tools](/tools/web) 以取得完整的 web_search 設定。
