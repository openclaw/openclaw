---
summary: "稽核哪些功能會產生費用、使用哪些金鑰，以及如何檢視使用量"
read_when:
  - 您想了解哪些功能可能會呼叫付費 API
  - 您需要稽核金鑰、成本和使用量可見性
  - 您正在解釋 /status 或 /usage 的成本報告
title: "API 使用量與成本"
---

# API 使用量與成本

本文件列出了**可能呼叫 API 金鑰**的功能，以及其成本顯示位置。本文件著重於可能產生供應商使用量或付費 API 呼叫的 OpenClaw 功能。

## 成本顯示位置 (聊天 + CLI)

**每個工作階段的成本快照**

- `/status` 顯示目前的工作階段模型、上下文使用量和上次回應的 token。
- 如果模型使用 **API 金鑰驗證**，`/status` 也會顯示上次回覆的**預估成本**。

**每個訊息的成本頁腳**

- `/usage full` 會在每個回覆中附加一個使用量頁腳，包含**預估成本** (僅限 API 金鑰)。
- `/usage tokens` 僅顯示 token；OAuth 流程會隱藏美元成本。

**CLI 使用量視窗 (供應商配額)**

- `openclaw status --usage` 和 `openclaw channels list` 顯示供應商的**使用量視窗** (配額快照，非每個訊息的成本)。

了解詳情與範例，請參閱 [Token 使用與成本](/reference/token-use)。

## 金鑰的探索方式

OpenClaw 可以從以下來源取得憑證：

- **驗證設定檔** (每個智慧代理，儲存在 `auth-profiles.json` 中)。
- **環境變數** (例如 `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`)。
- **設定** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`, `memorySearch.*`, `talk.apiKey`)。
- **Skills** (`skills.entries.<name>.apiKey`)，可能會將金鑰匯出到 skill 程序環境。

## 可能會產生費用金鑰的功能

### 1) 核心模型回應 (聊天 + 工具)

每次回覆或工具呼叫都會使用**目前的模型供應商** (OpenAI、Anthropic 等)。這是使用量和成本的主要來源。

有關定價設定，請參閱 [模型](/providers/models)；有關顯示方式，請參閱 [Token 使用與成本](/reference/token-use)。

### 2) 媒體理解 (音訊/圖片/影片)

在回覆執行之前，傳入的媒體可以被摘要/轉錄。這會使用模型/供應商的 API。

- 音訊：OpenAI / Groq / Deepgram (當金鑰存在時現已**自動啟用**)。
- 圖片：OpenAI / Anthropic / Google。
- 影片：Google。

請參閱 [媒體理解](/nodes/media-understanding)。

### 3) 記憶體嵌入 + 語義搜尋

當為遠端供應商設定時，語義記憶體搜尋會使用**嵌入 API**：

- `memorySearch.provider = "openai"` → OpenAI 嵌入
- `memorySearch.provider = "gemini"` → Gemini 嵌入
- `memorySearch.provider = "voyage"` → Voyage 嵌入
- 如果本地嵌入失敗，可選地回退到遠端供應商

您可以使用 `memorySearch.provider = "local"` 將其保持在本地 (不使用 API)。

請參閱 [記憶體](/concepts/memory)。

### 4) 網頁搜尋工具 (透過 OpenRouter 使用 Brave / Perplexity)

`web_search` 使用 API 金鑰並可能產生使用費用：

- **Brave Search API**: `BRAVE_API_KEY` 或 `tools.web.search.apiKey`
- **Perplexity** (透過 OpenRouter): `PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`

**Brave 免費方案 (慷慨):**

- **每月 2,000 次請求**
- **每秒 1 次請求**
- 驗證**需要信用卡** (除非升級，否則不收取費用)

請參閱 [網頁工具](/tools/web)。

### 5) 網頁擷取工具 (Firecrawl)

當存在 API 金鑰時，`web_fetch` 可以呼叫 **Firecrawl**：

- `FIRECRAWL_API_KEY` 或 `tools.web.fetch.firecrawl.apiKey`

如果未設定 Firecrawl，該工具會回退到直接擷取 + 可讀性 (不使用付費 API)。

請參閱 [網頁工具](/tools/web)。

### 6) 供應商使用量快照 (狀態/健康狀況)

某些狀態指令會呼叫**供應商使用量端點**以顯示配額視窗或驗證健康狀況。這些通常是低用量的呼叫，但仍會觸及供應商 API：

- `openclaw status --usage`
- `openclaw models status --json`

請參閱 [模型 CLI](/cli/models)。

### 7) 壓縮防護摘要

壓縮防護可以在執行時使用**目前模型**來摘要工作階段歷史，這會呼叫供應商 API。

請參閱 [工作階段管理 + 壓縮](/reference/session-management-compaction)。

### 8) 模型掃描 / 探測

`openclaw models scan` 可以探測 OpenRouter 模型，並在啟用探測時使用 `OPENROUTER_API_KEY`。

請參閱 [模型 CLI](/cli](/cli/models)。

### 9) 對話 (語音)

配置後，對話模式可以呼叫 **ElevenLabs**：

- `ELEVENLABS_API_KEY` 或 `talk.apiKey`

請參閱 [對話模式](/nodes/talk)。

### 10) Skills (第三方 API)

Skills 可以將 `apiKey` 儲存在 `skills.entries.<name>.apiKey` 中。如果 skill 使用該金鑰呼叫外部 API，則會根據 skill 的供應商產生費用。

請參閱 [Skills](/tools/skills)。
