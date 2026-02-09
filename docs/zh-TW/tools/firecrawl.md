---
summary: "用於 web_fetch 的 Firecrawl 備援（反機器人＋快取擷取）"
read_when:
  - 你想要以 Firecrawl 為後端的網頁擷取
  - 你需要一把 Firecrawl API 金鑰
  - 你想要為 web_fetch 進行反機器人擷取
title: "Firecrawl"
---

# Firecrawl

OpenClaw 可將 **Firecrawl** 作為 `web_fetch` 的備援擷取器。它是一項代管的
內容擷取服務，支援機器人規避與快取，對於 JS 密集型網站或
會阻擋純 HTTP 擷取的頁面特別有幫助。 33. 這是一項託管的內容擷取服務，支援機器人規避與快取，有助於處理 JS 密集的網站或封鎖純 HTTP 擷取的頁面。

## 取得 API 金鑰

1. 建立 Firecrawl 帳戶並產生一把 API 金鑰。
2. 將其儲存在設定中，或在 Gateway 閘道器環境中設定 `FIRECRAWL_API_KEY`。

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

- 當存在 API 金鑰時，`firecrawl.enabled` 會預設為 true。
- `maxAgeMs` controls how old cached results can be (ms). Default is 2 days.

## 34. 隱匿／機器人規避

35. Firecrawl 提供用於機器人規避的 **proxy mode** 參數（`basic`、`stealth` 或 `auto`）。
    Firecrawl 提供用於機器人規避的 **proxy mode** 參數（`basic`、`stealth` 或 `auto`）。
    OpenClaw 對 Firecrawl 請求一律使用 `proxy: "auto"` 加上 `storeInCache: true`。
    若省略 proxy，Firecrawl 會預設為 `auto`。若基本嘗試失敗，`auto` 會以隱匿代理重試，這可能比僅使用基本擷取消耗更多點數。
    If proxy is omitted, Firecrawl defaults to `auto`. `auto` retries with stealth proxies if a basic attempt fails, which may use more credits
    than basic-only scraping.

## `web_fetch` 如何使用 Firecrawl

`web_fetch` 的擷取順序：

1. Readability（本機）
2. Firecrawl（若已設定）
3. 基本 HTML 清理（最後備援）

完整的網頁工具設定請參閱 [Web tools](/tools/web)。
