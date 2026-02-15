---
summary: "用於 web_fetch 的 Firecrawl 備援（防機器人 + 快取式擷取）"
read_when:
  - 您需要 Firecrawl 支援的網頁擷取功能
  - 您需要 Firecrawl API 金鑰
  - 您需要用於 web_fetch 的防機器人擷取功能
title: "Firecrawl"
---

# Firecrawl

OpenClaw 可以使用 **Firecrawl** 作為 `web_fetch` 的備援擷取工具。它是一個託管的內容擷取服務，支援機器人規避和快取，這有助於處理大量使用 JS 的網站或阻擋純 HTTP 擷取的頁面。

## 取得 API 金鑰

1. 建立一個 Firecrawl 帳戶並產生一個 API 金鑰。
2. 將其儲存到設定中，或在 Gateway 環境中設定 `FIRECRAWL_API_KEY`。

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

- 當存在 API 金鑰時，`firecrawl.enabled` 預設為 true。
- `maxAgeMs` 控制快取結果的時效（毫秒）。預設為 2 天。

## 隱匿/機器人規避

Firecrawl 針對機器人規避暴露了一個 **代理模式** 參數（`basic`、`stealth` 或 `auto`）。OpenClaw 始終針對 Firecrawl 請求使用 `proxy: "auto"` 以及 `storeInCache: true`。如果省略 proxy，Firecrawl 預設為 `auto`。如果基本嘗試失敗，`auto` 會使用隱匿代理重試，這可能會比僅使用基本抓取消耗更多點數。

## `web_fetch` 如何使用 Firecrawl

`web_fetch` 擷取順序：

1. 可讀性 (local)
2. Firecrawl (如果已設定)
3. 基本 HTML 清理 (最終備援)

有關完整的網頁工具設定，請參閱[網頁工具](/tools/web)。
