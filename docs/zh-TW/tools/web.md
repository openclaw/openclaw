---
summary: "網頁搜尋 + 提取工具 (Brave Search API、Perplexity direct/OpenRouter)"
read_when:
  - 您想啟用 web_search 或 web_fetch
  - 您需要設定 Brave Search API 金鑰
  - 您想使用 Perplexity Sonar 進行網頁搜尋
title: "網頁工具"
---

# 網頁工具

OpenClaw 提供了兩種輕量級網頁工具：

- `web_search` — 透過 Brave Search API（預設）或 Perplexity Sonar（直接或透過 OpenRouter）搜尋網頁。
- `web_fetch` — HTTP 提取 + 可讀內容提取 (HTML → markdown/文字)。

這些**不是**瀏覽器自動化。對於需要大量 JavaScript 或登入的網站，請使用
[Browser 工具](/tools/browser)。

## 運作方式

- `web_search` 呼叫您設定的供應商並傳回結果。
  - **Brave**（預設）：傳回結構化結果（標題、URL、摘要）。
  - **Perplexity**：傳回帶有即時網頁搜尋引用的 AI 合成答案。
- 結果會根據查詢快取 15 分鐘（可設定）。
- `web_fetch` 執行一個純 HTTP GET 並提取可讀內容
  (HTML → markdown/文字)。它**不會**執行 JavaScript。
- `web_fetch` 預設為啟用（除非明確停用）。

## 選擇搜尋供應商

| 供應商            | 優點                                         | 缺點                                     | API 金鑰                                      |
| ------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **Brave**（預設） | 快速、結構化結果、免費方案                   | 傳統搜尋結果                             | `BRAVE_API_KEY`                              |
| **Perplexity**      | AI 合成答案、引用、即時                      | 需要 Perplexity 或 OpenRouter 存取權限 | `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY` |

請參閱 [Brave Search 設定](/brave-search) 和 [Perplexity Sonar](/perplexity) 以了解供應商特定詳細資訊。

在設定中設定供應商：

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // 或 "perplexity"
      },
    },
  },
}
```

範例：切換到 Perplexity Sonar（直接 API）：

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## 取得 Brave API 金鑰

1. 在 [https://brave.com/search/api/](https://brave.com/search/api/) 建立一個 Brave Search API 帳戶
2. 在儀表板中，選擇 **Data for Search** 方案（而不是「Data for AI」）並產生一個 API 金鑰。
3. 執行 `openclaw configure --section web` 將金鑰儲存在設定中（推薦），或在您的環境中設定 `BRAVE_API_KEY`。

Brave 提供免費方案和付費方案；請查看 Brave API 入口網站以了解
目前的限制和定價。

### 金鑰設定位置（推薦）

**推薦：** 執行 `openclaw configure --section web`。它會將金鑰儲存在
`~/.openclaw/openclaw.json` 中的 `tools.web.search.apiKey` 下。

**環境替代方案：** 在 Gateway 處理程序環境中設定 `BRAVE_API_KEY`。對於 Gateway 安裝，請將其放入 `~/.openclaw/.env`（或您的服務環境）。請參閱 [環境變數](/help/faq#how-does-openclaw-load-environment-variables)。

## 使用 Perplexity（直接或透過 OpenRouter）

Perplexity Sonar 模型具有內建的網頁搜尋功能，並傳回 AI 合成
的答案和引用。您可以透過 OpenRouter 使用它們（無需信用卡 - 支援
加密貨幣/預付）。

### 取得 OpenRouter API 金鑰

1. 在 [https://openrouter.ai/](https://openrouter.ai/) 建立帳戶
2. 新增點數（支援加密貨幣、預付或信用卡）
3. 在您的帳戶設定中產生 API 金鑰

### 設定 Perplexity 搜尋

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API 金鑰（如果已設定 OPENROUTER_API_KEY 或 PERPLEXITY_API_KEY 則為可選）
          apiKey: "sk-or-v1-...",
          // 基礎 URL（如果省略，則為與金鑰相關的預設值）
          baseUrl: "https://openrouter.ai/api/v1",
          // 模型（預設為 perplexity/sonar-pro）
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**環境替代方案：** 在 Gateway 環境中設定 `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY`。對於 Gateway 安裝，請將其放入 `~/.openclaw/.env`。

如果未設定基礎 URL，OpenClaw 會根據 API 金鑰來源選擇一個預設值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 或 `sk-or-...` → `https://openrouter.ai/api/v1`
- 未知的金鑰格式 → OpenRouter（安全備用）

### 可用的 Perplexity 模型

| 模型                            | 說明                          | 最適合          |
| -------------------------------- | ------------------------------------ | ----------------- |
| `perplexity/sonar`               | 帶有網頁搜尋的快速問答             | 快速查詢     |
| `perplexity/sonar-pro`（預設） | 帶有網頁搜尋的多步驟推理 | 複雜問題 |
| `perplexity/sonar-reasoning-pro` | 思考鏈分析            | 深度研究     |

## web_search

使用您設定的供應商搜尋網頁。

### 需求

- `tools.web.search.enabled` 不得為 `false`（預設：啟用）
- 您所選供應商的 API 金鑰：
  - **Brave**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
  - **Perplexity**：`OPENROUTER_API_KEY`、`PERPLEXITY_API_KEY` 或 `tools.web.search.perplexity.apiKey`

### 設定

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // 如果已設定 BRAVE_API_KEY 則為可選
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### 工具參數

- `query`（必填）
- `count`（1-10；預設來自設定）
- `country`（可選）：2 字母國家/地區代碼，用於特定地區結果（例如，"DE"、"US"、"ALL"）。如果省略，Brave 會選擇其預設地區。
- `search_lang`（可選）：用於搜尋結果的 ISO 語言代碼（例如，"de"、"en"、"fr"）
- `ui_lang`（可選）：用於 UI 元素的 ISO 語言代碼
- `freshness`（可選，僅限 Brave）：按發現時間篩選（`pd`、`pw`、`pm`、`py` 或 `YYYY-MM-DDtoYYYY-MM-DD`）

**範例：**

```javascript
// 德國特定搜尋
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// 法文搜尋與法文 UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// 最新結果（過去一週）
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

提取 URL 並提取可讀內容。

### web_fetch 需求

- `tools.web.fetch.enabled` 不得為 `false`（預設：啟用）
- 可選的 Firecrawl 備用：設定 `tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`。

### web_fetch 設定

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // 如果已設定 FIRECRAWL_API_KEY 則為可選
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // 毫秒 (1 天)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch 工具參數

- `url`（必填，僅限 http/https）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截斷長頁面）

注意事項：

- `web_fetch` 首先使用 Readability（主要內容提取），然後使用 Firecrawl（如果已設定）。如果兩者都失敗，工具會傳回錯誤。
- Firecrawl 請求使用 bot 規避模式，並預設快取結果。
- `web_fetch` 預設傳送類似 Chrome 的 User-Agent 和 `Accept-Language`；如果需要，請覆寫 `userAgent`。
- `web_fetch` 會封鎖私人/內部主機名並重新檢查重新導向（使用 `maxRedirects` 限制）。
- `maxChars` 會被限制在 `tools.web.fetch.maxCharsCap`。
- `web_fetch` 是盡力而為的提取；某些網站需要瀏覽器工具。
- 請參閱 [Firecrawl](/tools/firecrawl) 以了解金鑰設定和服務詳細資訊。
- 響應會被快取（預設 15 分鐘）以減少重複提取。
- 如果您使用工具設定檔/允許列表，請新增 `web_search`/`web_fetch` 或 `group:web`。
- 如果缺少 Brave 金鑰，`web_search` 會傳回一個簡短的設定提示以及文件連結。
