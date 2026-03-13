---
summary: "Web search + fetch tools (Brave, Gemini, Grok, Kimi, and Perplexity providers)"
read_when:
  - You want to enable web_search or web_fetch
  - You need provider API key setup
  - You want to use Gemini with Google Search grounding
title: Web Tools
---

# 網路工具

OpenClaw 提供兩款輕量級的網路工具：

- `web_search` — 使用 Brave Search API、結合 Google Search 的 Gemini、Grok、Kimi，或 Perplexity Search API 進行網路搜尋。
- `web_fetch` — HTTP 抓取 + 可讀內容擷取（HTML → markdown/文字）。

這些**不是**瀏覽器自動化工具。對於大量使用 JS 的網站或需要登入的情況，請使用
[瀏覽器工具](/tools/browser)。

## 運作原理

- `web_search` 會呼叫你設定的提供者並回傳結果。
- 結果會以查詢為單位快取 15 分鐘（可設定）。
- `web_fetch` 會執行純 HTTP GET 並擷取可讀內容
  （HTML → markdown/文字），**不會**執行 JavaScript。
- `web_fetch` 預設啟用（除非明確停用）。

請參考 [Brave Search 設定](/brave-search) 與 [Perplexity Search 設定](/perplexity) 了解提供者相關細節。

## 選擇搜尋提供者

| 提供者                    | 結果格式           | 提供者專屬過濾器                             | 備註                                             | API 金鑰                                    |
| ------------------------- | ------------------ | -------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| **Brave Search API**      | 結構化結果含摘要   | `country`, `language`, `ui_lang`, 時間       | 支援 Brave `llm-context` 模式                    | `BRAVE_API_KEY`                             |
| **Gemini**                | AI 合成答案 + 引用 | —                                            | 使用 Google Search 作為基礎                      | `GEMINI_API_KEY`                            |
| **Grok**                  | AI 合成答案 + 引用 | —                                            | 使用 xAI 網路基礎回應                            | `XAI_API_KEY`                               |
| **Kimi**                  | AI 合成答案 + 引用 | —                                            | 使用 Moonshot 網路搜尋                           | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| **Perplexity Search API** | 結構化結果含摘要   | `country`, `language`, 時間, `domain_filter` | 支援內容擷取控制；OpenRouter 使用 Sonar 相容路徑 | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |

### 自動偵測

上表依字母排序。若未明確設定 `provider`，執行時會依下列順序自動偵測提供者：

1. **Brave** — `BRAVE_API_KEY` 環境變數或 `tools.web.search.apiKey` 設定
2. **Gemini** — `GEMINI_API_KEY` 環境變數或 `tools.web.search.gemini.apiKey` 設定
3. **Grok** — `XAI_API_KEY` 環境變數或 `tools.web.search.grok.apiKey` 設定
4. **Kimi** — `KIMI_API_KEY` / `MOONSHOT_API_KEY` 環境變數或 `tools.web.search.kimi.apiKey` 設定
5. **Perplexity** — `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, 或 `tools.web.search.perplexity.apiKey` 設定

若找不到任何金鑰，會回退使用 Brave（此時會出現缺少金鑰錯誤，提示你需設定金鑰）。

執行時 SecretRef 行為：

- 網路工具的 SecretRef 會在 gateway 啟動或重新載入時一次性解析。
- 自動偵測模式下，OpenClaw 僅解析被選中提供者的金鑰。未被選中的提供者 SecretRef 會保持不活躍，直到被選中。
- 若選中提供者的 SecretRef 無法解析，且沒有提供環境變數備援，啟動或重新載入會立即失敗。

## 設定網路搜尋

使用 `openclaw configure --section web` 來設定您的 API 金鑰並選擇供應商。

### Brave 搜尋

1. 在 [brave.com/search/api](https://brave.com/search/api/) 建立 Brave Search API 帳號
2. 在儀表板中選擇 **Search** 計畫並產生 API 金鑰。
3. 執行 `openclaw configure --section web` 將金鑰儲存到設定檔，或在您的環境中設定 `BRAVE_API_KEY`。

每個 Brave 計畫包含 **每月 5 美元的免費額度**（會自動續期）。Search 計畫每 1,000 次請求收費 5 美元，因此免費額度可涵蓋每月 1,000 次查詢。請在 Brave 儀表板設定使用上限，以避免意外費用。詳細計畫與價格請參考 [Brave API 入口網站](https://brave.com/search/api/)。

### Perplexity 搜尋

1. 在 [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) 建立 Perplexity 帳號
2. 在儀表板產生 API 金鑰
3. 執行 `openclaw configure --section web` 將金鑰儲存到設定檔，或在您的環境中設定 `PERPLEXITY_API_KEY`。

為了相容舊版 Sonar/OpenRouter，請改設定 `OPENROUTER_API_KEY`，或使用 `tools.web.search.perplexity.apiKey` 配合 `sk-or-...` 金鑰。設定 `tools.web.search.perplexity.baseUrl` 或 `model` 也會讓 Perplexity 回到聊天完成相容路徑。

更多細節請參考 [Perplexity Search API 文件](https://docs.perplexity.ai/guides/search-quickstart)。

### 金鑰儲存位置

**透過設定檔：** 執行 `openclaw configure --section web`。金鑰會儲存在供應商專屬的設定路徑下：

- Brave: `tools.web.search.apiKey`
- Gemini: `tools.web.search.gemini.apiKey`
- Grok: `tools.web.search.grok.apiKey`
- Kimi: `tools.web.search.kimi.apiKey`
- Perplexity: `tools.web.search.perplexity.apiKey`

以上欄位皆支援 SecretRef 物件。

**透過環境變數：** 在 Gateway 程式環境中設定供應商的環境變數：

- Brave: `BRAVE_API_KEY`
- Gemini: `GEMINI_API_KEY`
- Grok: `XAI_API_KEY`
- Kimi: `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`
- Perplexity: `PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`

對於閘道器安裝，請將這些放入 `~/.openclaw/.env`（或您的服務環境）。詳見 [環境變數](/help/faq#how-does-openclaw-load-environment-variables)。

### 設定範例

**Brave 搜尋：**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: "YOUR_BRAVE_API_KEY", // optional if BRAVE_API_KEY is set // pragma: allowlist secret
      },
    },
  },
}
```

**Brave LLM 上下文模式：**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: "YOUR_BRAVE_API_KEY", // optional if BRAVE_API_KEY is set // pragma: allowlist secret
        brave: {
          mode: "llm-context",
        },
      },
    },
  },
}
```

`llm-context` 回傳用於基礎的擷取頁面區塊，而非標準 Brave 摘要。
在此模式下，`country` 和 `language` / `search_lang` 仍可使用，但 `ui_lang`、
`freshness`、`date_after` 和 `date_before` 將被拒絕。

**Perplexity 搜尋：**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...", // optional if PERPLEXITY_API_KEY is set
        },
      },
    },
  },
}
```

**透過 OpenRouter / Sonar 相容性的 Perplexity：**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          apiKey: "<openrouter-api-key>", // optional if OPENROUTER_API_KEY is set
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## 使用 Gemini（Google 搜尋基礎）

Gemini 模型支援內建的 [Google 搜尋基礎](https://ai.google.dev/gemini-api/docs/grounding)，
可回傳由即時 Google 搜尋結果佐證並附帶引用的 AI 合成答案。

### 取得 Gemini API 金鑰

1. 前往 [Google AI Studio](https://aistudio.google.com/apikey)
2. 建立 API 金鑰
3. 在閘道器環境中設定 `GEMINI_API_KEY`，或設定 `tools.web.search.gemini.apiKey`

### 設定 Gemini 搜尋

```json5
{
  tools: {
    web: {
      search: {
        provider: "gemini",
        gemini: {
          // API key (optional if GEMINI_API_KEY is set)
          apiKey: "AIza...",
          // Model (defaults to "gemini-2.5-flash")
          model: "gemini-2.5-flash",
        },
      },
    },
  },
}
```

**環境替代方案：** 在 Gateway 環境中設定 `GEMINI_API_KEY`。
若為 gateway 安裝，請放在 `~/.openclaw/.env`。

### 注意事項

- Gemini grounding 的引用 URL 會自動從 Google 的重定向 URL 解析為直接 URL。
- 重定向解析會使用 SSRF 防護路徑（HEAD + 重定向檢查 + http/https 驗證）後，才回傳最終引用 URL。
- 重定向解析採用嚴格的 SSRF 預設設定，因此會阻擋指向私有/內部目標的重定向。
- 預設模型 (`gemini-2.5-flash`) 速度快且成本效益高。
  任何支援 grounding 的 Gemini 模型皆可使用。

## web_search

使用您設定的提供者進行網路搜尋。

### 需求

- `tools.web.search.enabled` 不得為 `false`（預設：啟用）
- 您所選提供者的 API 金鑰：
  - **Brave**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
  - **Gemini**：`GEMINI_API_KEY` 或 `tools.web.search.gemini.apiKey`
  - **Grok**：`XAI_API_KEY` 或 `tools.web.search.grok.apiKey`
  - **Kimi**：`KIMI_API_KEY`、`MOONSHOT_API_KEY` 或 `tools.web.search.kimi.apiKey`
  - **Perplexity**：`PERPLEXITY_API_KEY`、`OPENROUTER_API_KEY` 或 `tools.web.search.perplexity.apiKey`
- 上述所有提供者的金鑰欄位皆支援 SecretRef 物件。

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

所有參數適用於 Brave 及原生 Perplexity Search API，除非另有說明。

Perplexity 的 OpenRouter / Sonar 相容路徑僅支援 `query` 和 `freshness`。
若您設定 `tools.web.search.perplexity.baseUrl` / `model`、使用 `OPENROUTER_API_KEY`，或設定 `sk-or-...` 金鑰，僅限 Search API 的過濾器會回傳明確錯誤。

| 參數                  | 說明                                        |
| --------------------- | ------------------------------------------- |
| `query`               | 搜尋查詢（必填）                            |
| `count`               | 回傳結果數量（1-10，預設：5）               |
| `country`             | 2 字母 ISO 國家程式碼（例如 "US", "DE"）    |
| `language`            | ISO 639-1 語言程式碼（例如 "en", "de"）     |
| `freshness`           | 時間篩選：`day`、`week`、`month` 或 `year`  |
| `date_after`          | 篩選此日期之後的結果（YYYY-MM-DD）          |
| `date_before`         | 篩選此日期之前的結果（YYYY-MM-DD）          |
| `ui_lang`             | UI 語言程式碼（僅 Brave）                   |
| `domain_filter`       | 網域允許清單/拒絕清單陣列（僅 Perplexity）  |
| `max_tokens`          | 總內容預算，預設 25000（僅 Perplexity）     |
| `max_tokens_per_page` | 每頁 token 限制，預設 2048（僅 Perplexity） |

**範例：**

javascript
// 德語特定搜尋
await web_search({
query: "TV online schauen",
country: "DE",
language: "de",
});

// 最近結果（過去一週）
await web_search({
query: "TMBG interview",
freshness: "week",
});

// 日期範圍搜尋
await web_search({
query: "AI developments",
date_after: "2024-01-01",
date_before: "2024-06-30",
});

// 網域過濾（僅限 Perplexity）
await web_search({
query: "climate research",
domain_filter: ["nature.com", "science.org", ".edu"],
});

// 排除網域（僅限 Perplexity）
await web_search({
query: "product reviews",
domain_filter: ["-reddit.com", "-pinterest.com"],
});

// 更多內容擷取（僅限 Perplexity）
await web_search({
query: "detailed AI research",
max_tokens: 50000,
max_tokens_per_page: 4096,
});

當 Brave `llm-context` 模式啟用時，`ui_lang`、`freshness`、`date_after` 和 `date_before` 不被支援。請使用 Brave `web` 模式來使用這些過濾器。

## web_fetch

擷取 URL 並抽取可閱讀內容。

### web_fetch 需求

- `tools.web.fetch.enabled` 不可為 `false`（預設：啟用）
- 可選 Firecrawl 備援：設定 `tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`。
- `tools.web.fetch.firecrawl.apiKey` 支援 SecretRef 物件。

### web_fetch 設定

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        maxResponseBytes: 2000000,
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

- `url`（必填，僅限 http/https）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截斷過長的頁面）

備註：

- `web_fetch` 會先使用 Readability（主內容擷取），若失敗則使用 Firecrawl（若已設定）。兩者皆失敗時，工具會回傳錯誤。
- Firecrawl 請求預設使用機器人繞過模式並快取結果。
- Firecrawl 的 SecretRefs 僅在 Firecrawl 啟用時 (`tools.web.fetch.enabled !== false` 和 `tools.web.fetch.firecrawl.enabled !== false`) 解析。
- 若 Firecrawl 啟用且其 SecretRef 未解析且無 `FIRECRAWL_API_KEY` 備援，啟動或重新載入會快速失敗。
- `web_fetch` 預設會送出類似 Chrome 的 User-Agent 及 `Accept-Language`；如有需要可覆寫 `userAgent`。
- `web_fetch` 會阻擋私有/內部主機名稱並重新檢查重定向（限制次數由 `maxRedirects` 控制）。
- `maxChars` 會被限制在 `tools.web.fetch.maxCharsCap` 範圍內。
- `web_fetch` 會將下載的回應主體大小限制在 `tools.web.fetch.maxResponseBytes`，超過部分會截斷並附帶警告。
- `web_fetch` 是盡力而為的擷取方式；部分網站仍需使用瀏覽器工具。
- 詳情請參考 [Firecrawl](/tools/firecrawl) 的主要設定與服務說明。
- 回應會快取（預設 15 分鐘）以減少重複抓取。
- 若使用工具設定檔或允許清單，請加入 `web_search`/`web_fetch` 或 `group:web`。
- 若缺少 API 金鑰，`web_search` 會回傳簡短的設定提示及文件連結。
