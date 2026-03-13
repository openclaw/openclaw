---
summary: Perplexity Search API and Sonar/OpenRouter compatibility for web_search
read_when:
  - You want to use Perplexity Search for web search
  - You need PERPLEXITY_API_KEY or OPENROUTER_API_KEY setup
title: Perplexity Search
---

# Perplexity 搜尋 API

OpenClaw 支援 Perplexity 搜尋 API 作為 `web_search` 提供者。  
它會回傳包含 `title`、`url` 和 `snippet` 欄位的結構化結果。

為了相容性，OpenClaw 也支援舊版 Perplexity Sonar/OpenRouter 設定。  
如果你使用 `OPENROUTER_API_KEY`、在 `tools.web.search.perplexity.apiKey` 中使用 `sk-or-...` 金鑰，或設定 `tools.web.search.perplexity.baseUrl` / `model`，提供者會切換到 chat-completions 路徑，並回傳帶有引用來源的 AI 合成答案，而非結構化的搜尋 API 結果。

## 取得 Perplexity API 金鑰

1. 在 <https://www.perplexity.ai/settings/api> 建立 Perplexity 帳號
2. 在儀表板產生 API 金鑰
3. 將金鑰儲存在設定檔中，或在 Gateway 環境變數中設定 `PERPLEXITY_API_KEY`。

## OpenRouter 相容性

如果你已經在使用 OpenRouter 來搭配 Perplexity Sonar，請保留 `provider: "perplexity"`，並在 Gateway 環境變數中設定 `OPENROUTER_API_KEY`，或將 `sk-or-...` 金鑰儲存在 `tools.web.search.perplexity.apiKey`。

可選的舊版控制項：

- `tools.web.search.perplexity.baseUrl`
- `tools.web.search.perplexity.model`

## 設定範例

### 原生 Perplexity 搜尋 API

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
        },
      },
    },
  },
}
```

### OpenRouter / Sonar 相容性

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "<openrouter-api-key>",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## 金鑰設定位置

**透過設定檔：**執行 `openclaw configure --section web`。它會將金鑰儲存在 `~/.openclaw/openclaw.json` 的 `tools.web.search.perplexity.apiKey` 下。該欄位也接受 SecretRef 物件。

**透過環境變數：**在 Gateway 程序環境中設定 `PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`。對於 Gateway 安裝，請放在 `~/.openclaw/.env`（或您的服務環境）中。詳見 [環境變數](/help/faq#how-does-openclaw-load-environment-variables)。

如果已設定 `provider: "perplexity"`，且 Perplexity 金鑰的 SecretRef 無法解析且沒有環境變數備援，啟動或重新載入將會快速失敗。

## 工具參數

這些參數適用於原生 Perplexity Search API 路徑。

| 參數                  | 說明                                                 |
| --------------------- | ---------------------------------------------------- |
| `query`               | 搜尋查詢（必填）                                     |
| `count`               | 回傳結果數量（1-10，預設：5）                        |
| `country`             | 兩字母 ISO 國家程式碼（例如 "US", "DE"）             |
| `language`            | ISO 639-1 語言程式碼（例如 "en", "de", "fr"）        |
| `freshness`           | 時間篩選：`day`（24小時）、`week`、`month` 或 `year` |
| `date_after`          | 僅回傳此日期（YYYY-MM-DD）之後發佈的結果             |
| `date_before`         | 僅回傳此日期（YYYY-MM-DD）之前發佈的結果             |
| `domain_filter`       | 網域允許清單/拒絕清單陣列（最多 20 個）              |
| `max_tokens`          | 總內容配額（預設：25000，最大：1000000）             |
| `max_tokens_per_page` | 每頁 token 限制（預設：2048）                        |

對於舊版 Sonar/OpenRouter 相容路徑，僅支援 `query` 和 `freshness`。搜尋 API 專用的篩選器如 `country`、`language`、`date_after`、`date_before`、`domain_filter`、`max_tokens` 和 `max_tokens_per_page` 會回傳明確錯誤。

**範例：**

javascript
// 國家與語言特定搜尋
await web_search({
query: "renewable energy",
country: "DE",
language: "de",
});

// 最近結果（過去一週）
await web_search({
query: "AI news",
freshness: "week",
});

// 日期區間搜尋
await web_search({
query: "AI developments",
date_after: "2024-01-01",
date_before: "2024-06-30",
});

// 網域篩選（允許清單）
await web_search({
query: "climate research",
domain_filter: ["nature.com", "science.org", ".edu"],
});

// 網域篩選（拒絕清單 - 前綴加 -）
await web_search({
query: "product reviews",
domain_filter: ["-reddit.com", "-pinterest.com"],
});

// 更多內容擷取
await web_search({
query: "detailed AI research",
max_tokens: 50000,
max_tokens_per_page: 4096,
});

### 網域篩選規則

- 每個過濾器最多 20 個網域
- 不可在同一請求中混用允許清單與拒絕清單
- 拒絕清單條目請使用 `-` 前綴（例如 `["-reddit.com"]`）

## 注意事項

- Perplexity Search API 回傳結構化的網頁搜尋結果 (`title`、`url`、`snippet`)
- 使用 OpenRouter 或明確的 `baseUrl` / `model` 會將 Perplexity 切換回 Sonar 聊天完成模式以維持相容性
- 預設結果會快取 15 分鐘（可透過 `cacheTtlMinutes` 設定調整）

請參考 [Web tools](/tools/web) 以取得完整的 web_search 設定說明。
更多細節請見 [Perplexity Search API 文件](https://docs.perplexity.ai/docs/search/quickstart)。
