---
summary: "為 web_fetch 提供 Firecrawl 備援方案（防機器人偵測 + 快取擷取）"
read_when:
  - 您想要使用 Firecrawl 支援的網頁擷取
  - 您需要 Firecrawl API 金鑰
  - 您希望為 web_fetch 增加防機器人偵測的擷取功能
title: "Firecrawl"
---

# Firecrawl

OpenClaw 可以使用 **Firecrawl** 作為 `web_fetch` 的備援擷取器。它是一項託管的內容擷取服務，支援規避機器人偵測和快取功能，有助於處理大量使用 JavaScript 的網站或阻擋一般 HTTP 擷取的頁面。

## 取得 API 金鑰

1. 建立 Firecrawl 帳號並產生 API 金鑰。
2. 將其儲存在設定中，或在 Gateway 環境變數中設定 `FIRECRAWL_API_KEY`。

## 設定 Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "在此輸入_FIRECRAWL_API_KEY",
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

說明：

- 當存在 API 金鑰時，`firecrawl.enabled` 預設為 true。
- `maxAgeMs` 控制快取結果的有效期（毫秒）。預設為 2 天。

## 隱身 / 規避機器人偵測

Firecrawl 提供了一個用於規避機器人偵測的 **proxy mode** 參數（`basic`、`stealth` 或 `auto`）。
OpenClaw 對於 Firecrawl 請求一律使用 `proxy: "auto"` 加上 `storeInCache: true`。
如果省略 proxy，Firecrawl 預設為 `auto`。若基本嘗試失敗，`auto` 會使用 stealth 代理伺服器重試，這可能會比僅使用基本（basic）爬取消耗更多點數（credits）。

## web_fetch 如何使用 Firecrawl

`web_fetch` 的擷取順序：

1. Readability (本地)
2. Firecrawl (若已設定)
3. 基本 HTML 清理 (最後的備援方案)

請參閱 [Web 工具](/tools/web) 以了解完整的 Web 工具設定。
