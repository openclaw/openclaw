---
summary: "審查哪些功能會產生費用、使用了哪些金鑰以及如何查看用量"
read_when:
  - 您想要瞭解哪些功能可能會呼叫付費 API
  - 您需要審查金鑰、成本和用量可見性
  - 您正在說明 /status 或 /usage 的成本報告
title: "API 用量與成本"
---

# API 用量與成本

本文件列出了會調用 API 金鑰的功能，以及其成本顯示的位置。重點在於 OpenClaw 中會產生供應商用量或付費 API 呼叫的功能。

## 成本顯示位置（聊天 + CLI）

**每個工作階段的成本快照**

- `/status` 顯示目前的工作階段模型、內容用量，以及最後一則回應的 Token 數。
- 如果模型使用 **API 金鑰驗證**，`/status` 也會顯示最後一則回覆的**預估成本**。

**每則訊息的成本頁尾**

- `/usage full` 會在每則回覆後方附加用量頁尾，包含**預估成本**（僅限 API 金鑰）。
- `/usage tokens` 僅顯示 Token；OAuth 流程會隱藏金額。

**CLI 用量視窗（供應商配額）**

- `openclaw status --usage` 和 `openclaw channels list` 會顯示供應商的**用量視窗**（配額快照，而非單則訊息的成本）。

請參閱 [Token 使用與成本](/reference/token-use) 了解詳情與範例。

## 金鑰探索方式

OpenClaw 可以從以下來源獲取憑證：

- **憑證設定檔**（每個智慧代理獨立設定，儲存於 `auth-profiles.json`）。
- **環境變數**（例如 `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **設定**（`models.providers.*.apiKey`、`tools.web.search.*`、`tools.web.fetch.firecrawl.*`、`memorySearch.*`、`talk.apiKey`）。
- **Skills**（`skills.entries.<name>.apiKey`），可能會將金鑰匯出至 Skills 程序環境。

## 會消耗金鑰的功能

### 1) 核心模型回應（聊天 + 工具）

每一則回覆或工具呼叫都會使用**目前的模型供應商**（OpenAI、Anthropic 等）。這是用量與成本的主要來源。

請參閱 [模型](/providers/models) 了解價格設定，以及 [Token 使用與成本](/reference/token-use) 了解顯示方式。

### 2) 媒體理解（音訊/圖像/影片）

在回覆執行前，輸入的媒體可以被摘要或轉錄。這會使用模型/供應商 API。

- 音訊：OpenAI / Groq / Deepgram（現在金鑰存在時會**自動啟用**）。
- 圖像：OpenAI / Anthropic / Google。
- 影片：Google。

請參閱 [媒體理解](/nodes/media-understanding)。

### 3) 記憶體嵌入與語義搜尋

當設定為遠端供應商時，語義記憶體搜尋會使用**嵌入 API**：

- `memorySearch.provider = "openai"` → OpenAI 嵌入
- `memorySearch.provider = "gemini"` → Gemini 嵌入
- `memorySearch.provider = "voyage"` → Voyage 嵌入
- 如果本地嵌入失敗，可選擇備援至遠端供應商

您可以將其保留在本地，設定 `memorySearch.provider = "local"`（無 API 用量）。

請參閱 [記憶體](/concepts/memory)。

### 4) 網頁搜尋工具（經由 OpenRouter 的 Brave / Perplexity）

`web_search` 會使用 API 金鑰，且可能會產生用量費用：

- **Brave Search API**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
- **Perplexity**（經由 OpenRouter）：`PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`

**Brave 免費層級（非常慷慨）：**

- **每月 2,000 次請求**
- **每秒 1 次請求**
- 需要**信用卡**進行驗證（除非您升級，否則不會扣費）

請參閱 [網頁工具](/tools/web)。

### 5) 網頁抓取工具（Firecrawl）

當 API 金鑰存在時，`web_fetch` 可以呼叫 **Firecrawl**：

- `FIRECRAWL_API_KEY` 或 `tools.web.fetch.firecrawl.apiKey`

如果未設定 Firecrawl，該工具會降級使用直接抓取 + 可讀性處理（無付費 API）。

請參閱 [網頁工具](/tools/web)。

### 6) 供應商用量快照（狀態/健康檢查）

某些狀態指令會呼叫**供應商用量端點**，以顯示配額視窗或憑證健康狀況。這些通常是低流量呼叫，但仍會觸及供應商 API：

- `openclaw status --usage`
- `openclaw models status --json`

請參閱 [模型 CLI](/cli/models)。

### 7) 壓縮防護摘要

壓縮防護（Compaction safeguard）可以使用**目前的模型**對工作階段歷史進行摘要，執行時會調用供應商 API。

請參閱 [工作階段管理與壓縮](/reference/session-management-compaction)。

### 8) 模型掃描/探測

`openclaw models scan` 可以探測 OpenRouter 模型，並在啟用探測時使用 `OPENROUTER_API_KEY`。

請參閱 [模型 CLI](/cli/models)。

### 9) Talk（語音）

Talk 模式在設定後可以調用 **ElevenLabs**：

- `ELEVENLABS_API_KEY` 或 `talk.apiKey`

請參閱 [Talk 模式](/nodes/talk)。

### 10) Skills（第三方 API）

Skills 可以將 `apiKey` 儲存在 `skills.entries.<name>.apiKey` 中。如果 Skill 使用該金鑰進行外部 API 呼叫，則會根據該 Skill 供應商產生費用。

請參閱 [Skills](/tools/skills)。
