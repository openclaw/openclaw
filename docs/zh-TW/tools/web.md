---
summary: "網頁搜尋 + 擷取工具 (Brave Search API, Perplexity 直接/OpenRouter)"
read_when:
  - 您想要啟用 web_search 或 web_fetch
  - 您需要設定 Brave Search API 金鑰
  - 您想要使用 Perplexity Sonar 進行網頁搜尋
title: "網頁工具"
---

# 網頁工具

OpenClaw 內建兩款輕量級網頁工具：

- `web_search` — 透過 Brave Search API (預設) 或 Perplexity Sonar (直接或透過 OpenRouter) 搜尋網頁。
- `web_fetch` — HTTP 擷取 + 可讀性內容提取 (HTML → Markdown/純文字)。

這些工具**並非**瀏覽器自動化。對於需要大量執行 JavaScript 的網站或登入頁面，請使用
[Browser 工具](/tools/browser)。

## 運作方式

- `web_search` 呼叫您設定的供應商並回傳結果。
  - **Brave** (預設)：回傳結構化結果 (標題、URL、片段摘要)。
  - **Perplexity**：回傳 AI 合成的回答，並附帶來自即時網頁搜尋的引用來源。
- 結果會根據查詢內容快取 15 分鐘 (可自行設定)。
- `web_fetch` 執行一般的 HTTP GET 並提取可讀內容
  (HTML → Markdown/純文字)。它**不會**執行 JavaScript。
- `web_fetch` 預設為啟用 (除非明確停用)。

## 選擇搜尋供應商

| 供應商           | 優點                          | 缺點                               | API 金鑰                                     |
| ---------------- | ----------------------------- | ---------------------------------- | -------------------------------------------- |
| **Brave** (預設) | 快速、結構化結果、免費方案    | 傳統搜尋結果                       | `BRAVE_API_KEY`                              |
| **Perplexity**   | AI 合成回答、引用來源、即時性 | 需要 Perplexity 或 OpenRouter 權限 | `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY` |

請參閱 [Brave Search 設定](/brave-search) 與 [Perplexity Sonar](/perplexity) 了解供應商特定的詳細資訊。

在設定檔中設定供應商：

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

範例：切換至 Perplexity Sonar (直接連線 API)：

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

1. 在 [https://brave.com/search/api/](https://brave.com/search/api/) 建立 Brave Search API 帳戶。
2. 在控制台中，選擇 **Data for Search** 方案 (不是 “Data for AI”) 並產生一個 API 金鑰。
3. 執行 `openclaw configure --section web` 以將金鑰儲存在設定中 (推薦方式)，或是在您的環境中設定 `BRAVE_API_KEY`。

Brave 提供免費方案以及付費方案；請查看 Brave API 門戶網站了解目前的限制與定價。

### 金鑰設定位置 (推薦方式)

**推薦方式：** 執行 `openclaw configure --section web`。這會將金鑰儲存在 `~/.openclaw/openclaw.json` 中的 `tools.web.search.apiKey`。

**環境變數替代方案：** 在 Gateway 程序環境中設定 `BRAVE_API_KEY`。對於 Gateway 安裝，請將其放入 `~/.openclaw/.env` (或您的服務環境)。請參閱 [環境變數](/help/faq#how-does-openclaw-load-environment-variables)。

## 使用 Perplexity (直接或透過 OpenRouter)

Perplexity Sonar 模型內建網頁搜尋功能，並回傳附帶引用來源的 AI 合成回答。您可以透過 OpenRouter 使用它們 (無需信用卡，支援加密貨幣/預付)。

### 取得 OpenRouter API 金鑰

1. 在 [https://openrouter.ai/](https://openrouter.ai/) 建立帳戶。
2. 儲值點數 (支援加密貨幣、預付或信用卡)。
3. 在您的帳戶設定中產生一個 API 金鑰。

### 設定 Perplexity 搜尋

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API 金鑰 (如果已設定 OPENROUTER_API_KEY 或 PERPLEXITY_API_KEY 則為選填)
          apiKey: "sk-or-v1-...",
          // 基本 URL (若省略則根據金鑰來源自動判斷預設值)
          baseUrl: "https://openrouter.ai/api/v1",
          // 模型 (預設為 perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**環境變數替代方案：** 在 Gateway 環境中設定 `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY`。對於 Gateway 安裝，請將其放入 `~/.openclaw/.env`。

若未設定基本 URL，OpenClaw 會根據 API 金鑰來源選擇預設值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 或 `sk-or-...` → `https://openrouter.ai/api/v1`
- 未知金鑰格式 → OpenRouter (安全回退)

### 可用的 Perplexity 模型

| 模型                             | 描述                   | 最佳用途 |
| -------------------------------- | ---------------------- | -------- |
| `perplexity/sonar`               | 帶有網頁搜尋的快速問答 | 快速查閱 |
| `perplexity/sonar-pro` (預設)    | 帶有網頁搜尋的多步推理 | 複雜問題 |
| `perplexity/sonar-reasoning-pro` | 思維鏈分析             | 深入研究 |

## web_search

使用您設定的供應商搜尋網頁。

### 需求

- `tools.web.search.enabled` 不得為 `false` (預設為啟用)
- 您所選供應商的 API 金鑰：
  - **Brave**: `BRAVE_API_KEY` 或 `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`、`PERPLEXITY_API_KEY` 或 `tools.web.search.perplexity.apiKey`

### 設定

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // 若已設定 BRAVE_API_KEY 則為選填
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### 工具參數

- `query` (必要)
- `count` (1–10；預設來自設定)
- `country` (選填)：特定區域結果的 2 位字母國家代碼 (例如 "DE"、"US"、"ALL")。若省略，Brave 會選擇其預設區域。
- `search_lang` (選填)：搜尋結果的 ISO 語言代碼 (例如 "de"、"en"、"fr")
- `ui_lang` (選填)：UI 元素的 ISO 語言代碼
- `freshness` (選填，僅限 Brave)：根據探索時間篩選 (`pd`、`pw`、`pm`、`py` 或 `YYYY-MM-DDtoYYYY-MM-DD`)

**範例：**

```javascript
// 針對德國的搜尋
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// 使用法文 UI 進行法文搜尋
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// 最近的結果 (過去一週)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

擷取 URL 並提取可讀內容。

### web_fetch 需求

- `tools.web.fetch.enabled` 不得為 `false` (預設為啟用)
- 選填的 Firecrawl 回退方案：設定 `tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`。

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
          apiKey: "FIRECRAWL_API_KEY_HERE", // 若已設定 FIRECRAWL_API_KEY 則為選填
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

- `url` (必要，僅限 http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (截斷過長的頁面)

備註：

- `web_fetch` 會優先使用 Readability (主內容提取)，接著是 Firecrawl (若有設定)。若兩者皆失敗，工具會回傳錯誤。
- Firecrawl 請求預設使用規避機器人偵測模式並快取結果。
- `web_fetch` 預設會發送類似 Chrome 的 User-Agent 和 `Accept-Language`；如有需要請覆寫 `userAgent`。
- `web_fetch` 會封鎖私人/內部主機名稱並重新檢查重新導向 (由 `maxRedirects` 限制)。
- `maxChars` 會被限制在 `tools.web.fetch.maxCharsCap` 之內。
- `web_fetch` 屬於盡力提取；某些網站仍需要使用 Browser 工具。
- 請參閱 [Firecrawl](/tools/firecrawl) 了解金鑰設定與服務詳情。
- 回應會被快取 (預設 15 分鐘) 以減少重複擷取。
- 如果您使用工具設定檔 (Profiles)/允許清單，請加入 `web_search`/`web_fetch` 或 `group:web`。
- 如果遺失 Brave 金鑰，`web_search` 會回傳簡短的設定提示以及文件連結。
