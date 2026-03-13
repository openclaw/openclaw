---
summary: "Audit what can spend money, which keys are used, and how to view usage"
read_when:
  - You want to understand which features may call paid APIs
  - "You need to audit keys, costs, and usage visibility"
  - You’re explaining /status or /usage cost reporting
title: API Usage and Costs
---

# API 使用與費用

本文件列出**可能會調用 API 金鑰的功能**及其費用顯示位置。重點在於
OpenClaw 中會產生供應商使用量或付費 API 呼叫的功能。

## 費用顯示位置（聊天 + CLI）

**每次會話費用快照**

- `/status` 顯示目前會話的模型、上下文使用量及最後回應的 token 數。
- 若模型使用 **API 金鑰認證**，`/status` 也會顯示最後回覆的**預估費用**。

**每則訊息費用頁尾**

- `/usage full` 在每則回覆附加使用量頁尾，包含**預估費用**（僅限 API 金鑰）。
- `/usage tokens` 僅顯示 token 數；OAuth 流程則隱藏美元費用。

**CLI 使用視窗（供應商配額）**

- `openclaw status --usage` 和 `openclaw channels list` 顯示供應商的**使用視窗**
  （配額快照，非每則訊息費用）。

詳情與範例請參考 [Token 使用與費用](/reference/token-use)。

## 金鑰如何被發現

OpenClaw 可從以下來源取得憑證：

- **認證設定檔**（每個代理，存於 `auth-profiles.json`）。
- **環境變數**（例如 `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **設定檔**（`models.providers.*.apiKey`、`tools.web.search.*`、`tools.web.fetch.firecrawl.*`、
  `memorySearch.*`、`talk.apiKey`）。
- **技能**（`skills.entries.<name>.apiKey`），可能會將金鑰匯出到技能程序的環境變數。

## 可能會使用金鑰的功能

### 1) 核心模型回應（聊天 + 工具）

每次回覆或工具呼叫都使用**當前模型提供者**（OpenAI、Anthropic 等）。這是使用量和費用的主要來源。

請參考[模型](/providers/models)了解價格設定，以及[Token 使用與費用](/reference/token-use)以供顯示。

### 2) 媒體理解（音訊/圖片/影片）

輸入的媒體可以在回覆前進行摘要或轉錄。這會使用模型/提供者的 API。

- 音訊：OpenAI / Groq / Deepgram（當有金鑰時**自動啟用**）。
- 圖片：OpenAI / Anthropic / Google。
- 影片：Google。

請參考[媒體理解](/nodes/media-understanding)。

### 3) 記憶嵌入與語意搜尋

當設定遠端提供者時，語意記憶搜尋會使用**嵌入 API**：

- `memorySearch.provider = "openai"` → OpenAI 嵌入
- `memorySearch.provider = "gemini"` → Gemini 嵌入
- `memorySearch.provider = "voyage"` → Voyage 嵌入
- `memorySearch.provider = "mistral"` → Mistral 嵌入
- `memorySearch.provider = "ollama"` → Ollama 嵌入（本地/自架；通常無託管 API 計費）
- 若本地嵌入失敗，可選擇回退至遠端提供者

你也可以使用 `memorySearch.provider = "local"` 保持本地運作（無 API 使用）。

請參考[記憶](/concepts/memory)。

### 4) 網路搜尋工具

`web_search` 使用 API 金鑰，且可能依提供者產生使用費用：

- **Brave Search API**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
- **Gemini（Google 搜尋）**：`GEMINI_API_KEY` 或 `tools.web.search.gemini.apiKey`
- **Grok（xAI）**：`XAI_API_KEY` 或 `tools.web.search.grok.apiKey`
- **Kimi（Moonshot）**：`KIMI_API_KEY`、`MOONSHOT_API_KEY` 或 `tools.web.search.kimi.apiKey`
- **Perplexity Search API**：`PERPLEXITY_API_KEY`、`OPENROUTER_API_KEY` 或 `tools.web.search.perplexity.apiKey`

**Brave Search 免費額度：** 每個 Brave 計畫包含每月 5 美元的可續期免費額度。搜尋計畫每 1,000 次請求收費 5 美元，因此此額度可覆蓋每月 1,000 次請求的免費使用。請在 Brave 控制台設定使用上限，以避免意外產生費用。

請參考 [Web 工具](/tools/web)。

### 5) 網頁擷取工具 (Firecrawl)

`web_fetch` 在有 API 金鑰時可以呼叫 **Firecrawl**：

- `FIRECRAWL_API_KEY` 或 `tools.web.fetch.firecrawl.apiKey`

如果未設定 Firecrawl，該工具會退回使用直接擷取 + 可讀性分析（無付費 API）。

請參考 [Web 工具](/tools/web)。

### 6) 供應商使用快照（狀態/健康）

部分狀態指令會呼叫 **供應商使用端點** 以顯示配額視窗或認證狀態。
這些通常是低流量呼叫，但仍會觸及供應商 API：

- `openclaw status --usage`
- `openclaw models status --json`

請參考 [Models CLI](/cli/models)。

### 7) 壓縮保護摘要

壓縮保護功能可以使用 **當前模型** 來摘要會話歷史，
執行時會呼叫供應商 API。

請參考 [會話管理 + 壓縮](/reference/session-management-compaction)。

### 8) 模型掃描 / 探測

`openclaw models scan` 可以探測 OpenRouter 模型，並在啟用探測時使用 `OPENROUTER_API_KEY`。

請參閱 [Models CLI](/cli/models)。

### 9) Talk（語音）

Talk 模式在設定後可呼叫 **ElevenLabs**：

- `ELEVENLABS_API_KEY` 或 `talk.apiKey`

請參閱 [Talk mode](/nodes/talk)。

### 10) Skills（第三方 API）

Skills 可以將 `apiKey` 儲存在 `skills.entries.<name>.apiKey`。如果技能使用該金鑰呼叫外部 API，可能會依照技能提供者產生費用。

請參閱 [Skills](/tools/skills)。
