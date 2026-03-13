---
summary: Firecrawl fallback for web_fetch (anti-bot + cached extraction)
read_when:
  - You want Firecrawl-backed web extraction
  - You need a Firecrawl API key
  - You want anti-bot extraction for web_fetch
title: Firecrawl
---

# Firecrawl

OpenClaw 可以使用 **Firecrawl** 作為 `web_fetch` 的備用擷取器。它是一個託管的內容擷取服務，支援機器人繞過和快取，對於重度使用 JS 的網站或阻擋純 HTTP 抓取的頁面非常有幫助。

## 取得 API 金鑰

1. 建立 Firecrawl 帳號並產生 API 金鑰。
2. 將金鑰儲存在設定檔中，或在 gateway 環境變數中設定 `FIRECRAWL_API_KEY`。

## 設定 Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

注意事項：

- `firecrawl.enabled` 預設為 `true`，除非明確設定為 `false`。
- Firecrawl 備用嘗試僅在有 API 金鑰時執行（`tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`）。
- `maxAgeMs` 控制快取結果的有效期限（毫秒），預設為 2 天。

## 隱匿 / 機器人繞過

Firecrawl 提供一個 **代理模式** 參數用於機器人繞過（`basic`、`stealth` 或 `auto`）。  
OpenClaw 對 Firecrawl 請求總是使用 `proxy: "auto"` 加上 `storeInCache: true`。  
若未指定代理，Firecrawl 預設使用 `auto`。`auto` 會在基本嘗試失敗時使用隱匿代理重試，這可能會比只用基本抓取消耗更多點數。

## `web_fetch` 如何使用 Firecrawl

`web_fetch` 擷取順序：

1. Readability（本地）
2. Firecrawl（若有設定）
3. 基本 HTML 清理（最後備用）

完整的網頁工具設定請參考 [Web tools](/tools/web)。
