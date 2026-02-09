---
summary: "網頁搜尋＋擷取工具（Brave Search API、Perplexity 直接／OpenRouter）"
read_when:
  - 你想要啟用 web_search 或 web_fetch
  - 你需要設定 Brave Search API 金鑰
  - 你想要使用 Perplexity Sonar 進行網頁搜尋
title: "Web 工具"
---

# Web 工具

OpenClaw 隨附兩個輕量級的 Web 工具：

- `web_search` — 透過 Brave Search API（預設）或 Perplexity Sonar（直接或經由 OpenRouter）搜尋網頁。
- `web_fetch` — HTTP 擷取＋可讀內容抽取（HTML → markdown／文字）。

These are **not** browser automation. 對於 JS 密集型網站或登入，請使用
[Browser tool](/tools/browser)。

## How it works

- `web_search` 會呼叫你設定的提供者並回傳結果。
  - **Brave** (default): returns structured results (title, URL, snippet).
  - **Perplexity**：回傳含引用的 AI 綜合答案，來源為即時網頁搜尋。
- 結果會依查詢快取 15 分鐘（可設定）。
- `web_fetch` 會執行單純的 HTTP GET，並抽取可讀內容
  （HTML → markdown／文字）。它**不會**執行 JavaScript。 It does **not** execute JavaScript.
- `web_fetch` 預設為啟用（除非明確停用）。

## 選擇搜尋提供者

| 提供者            | Pros          | Cons                          | API 金鑰                                      |
| -------------- | ------------- | ----------------------------- | ------------------------------------------- |
| **Brave**（預設）  | 快速、結構化結果、免費方案 | 傳統搜尋結果                        | `BRAVE_API_KEY`                             |
| **Perplexity** | AI 綜合答案、引用、即時 | 需要 Perplexity 或 OpenRouter 存取 | `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY` |

請參閱 [Brave Search 設定](/brave-search) 與 [Perplexity Sonar](/perplexity) 以取得提供者專屬細節。

在設定中指定提供者：

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

範例：切換為 Perplexity Sonar（直接 API）：

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

1. 前往 [https://brave.com/search/api/](https://brave.com/search/api/) 建立 Brave Search API 帳戶
2. 在儀表板中選擇 **Data for Search** 方案（不是「Data for AI」），並產生 API 金鑰。
3. 執行 `openclaw configure --section web` 將金鑰儲存至設定（建議），或在環境中設定 `BRAVE_API_KEY`。

Brave 提供免費方案與付費方案；請查看 Brave API 入口網站以了解
目前的限制與定價。

### 在哪裡設定金鑰（建議）

**建議：** 執行 `openclaw configure --section web`。 **建議：** 執行 `openclaw configure --section web`。它會將金鑰儲存在
`~/.openclaw/openclaw.json` 的 `tools.web.search.apiKey` 之下。

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. 對於 Gateway 安裝，請將其放在 `~/.openclaw/.env`（或你的
服務環境）。 See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## 使用 Perplexity（直接或經由 OpenRouter）

Perplexity Sonar 模型具備內建的網頁搜尋能力，並回傳含引用的 AI 綜合答案。 You can use them via OpenRouter (no credit card required - supports
crypto/prepaid).

### 取得 OpenRouter API 金鑰

1. 前往 [https://openrouter.ai/](https://openrouter.ai/) 建立帳戶
2. 加值（支援加密貨幣、預付或信用卡）
3. 在帳戶設定中產生 API 金鑰

### 設定 Perplexity 搜尋

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**環境變數替代方案：** 在 Gateway
環境中設定 `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY`。對於 Gateway 安裝，請將它放在 `~/.openclaw/.env`。 對於 Gateway 安裝，請將其放在 `~/.openclaw/.env`。

如果未設定 base URL，OpenClaw 會根據 API 金鑰來源選擇預設值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 或 `sk-or-...` → `https://openrouter.ai/api/v1`
- 未知的金鑰格式 → OpenRouter（安全的後備）

### 可用的 Perplexity 模型

| 模型                               | Description | 最適合  |
| -------------------------------- | ----------- | ---- |
| `perplexity/sonar`               | 具網頁搜尋的快速問答  | 快速查詢 |
| `perplexity/sonar-pro`（預設）       | 具網頁搜尋的多步推理  | 複雜問題 |
| `perplexity/sonar-reasoning-pro` | 思維鏈分析       | 深度研究 |

## web_search

使用你設定的提供者進行網頁搜尋。

### 需求

- `tools.web.search.enabled` 不得為 `false`（預設：啟用）
- 你選擇之提供者的 API 金鑰：
  - **Brave**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
  - **Perplexity**：`OPENROUTER_API_KEY`、`PERPLEXITY_API_KEY` 或 `tools.web.search.perplexity.apiKey`

### 設定

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
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
- `count`（1–10；預設來自設定）
- `country`（選填）：用於地區限定結果的 2 碼國家代碼（例如「DE」、「US」、「ALL」）。若省略，Brave 會選擇其預設地區。 若省略，Brave 會選擇其預設地區。
- `search_lang`（選填）：搜尋結果的 ISO 語言代碼（例如「de」、「en」、「fr」）
- `ui_lang`（選填）：UI 元素的 ISO 語言代碼
- `freshness`（選填，僅 Brave）：依探索時間篩選（`pd`、`pw`、`pm`、`py` 或 `YYYY-MM-DDtoYYYY-MM-DD`）

**範例：**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

擷取一個 URL 並萃取可讀內容。

### web_fetch 需求

- `tools.web.fetch.enabled` 不得為 `false`（預設：啟用）
- 選用的 Firecrawl 後備：設定 `tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`。

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
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch 工具參數

- `url`（必填，僅 http／https）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截斷過長頁面）

注意事項：

- `web_fetch` 會先使用 Readability（主內容抽取），再使用 Firecrawl（若已設定）。若兩者皆失敗，工具會回傳錯誤。 如果兩者都失敗，工具會回傳錯誤。
- Firecrawl 請求預設使用規避機器人模式並快取結果。
- `web_fetch` 預設送出類 Chrome 的 User-Agent 與 `Accept-Language`；必要時可覆寫 `userAgent`。
- `web_fetch` 會封鎖私人／內部主機名稱並重新檢查重新導向（可用 `maxRedirects` 限制）。
- `maxChars` 會被限制為 `tools.web.fetch.maxCharsCap`。
- `web_fetch` 為盡力而為的抽取；部分網站需要使用瀏覽器工具。
- 金鑰設定與服務細節請參閱 [Firecrawl](/tools/firecrawl)。
- 回應會被快取（預設 15 分鐘）以減少重複擷取。
- 若你使用工具設定檔／允許清單，請加入 `web_search`/`web_fetch` 或 `group:web`。
- 若缺少 Brave 金鑰，`web_search` 會回傳簡短的設定提示並附上文件連結。
