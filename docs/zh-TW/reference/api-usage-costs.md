---
summary: "稽核哪些項目可能花費金錢、使用了哪些金鑰，以及如何檢視用量"
read_when:
  - 你想了解哪些功能可能會呼叫付費 API
  - 你需要稽核金鑰、成本與用量可視性
  - 你正在說明 /status 或 /usage 的成本回報
title: "API 使用與成本"
---

# API 使用與成本

This doc lists **features that can invoke API keys** and where their costs show up. It focuses on
OpenClaw features that can generate provider usage or paid API calls.

## 成本顯示位置（聊天 + CLI）

**每個工作階段的成本快照**

- `/status` shows the current session model, context usage, and last response tokens.
- 若模型使用 **API-key 身分驗證**，`/status` 也會顯示最後一則回覆的**預估成本**。

**每則訊息的成本頁尾**

- `/usage full` 會在每則回覆附加用量頁尾，包含**預估成本**（僅限 API-key）。
- `/usage tokens` 僅顯示權杖數；OAuth 流程會隱藏金額成本。

**CLI 用量視窗（提供者配額）**

- `openclaw status --usage` 與 `openclaw channels list` 顯示提供者的**用量視窗**
  （配額快照，而非每則訊息的成本）。

詳情與範例請參閱 [Token use & costs](/reference/token-use)。

## 金鑰如何被發現

OpenClaw 可以從以下來源取得認證：

- **Auth profiles**（每個代理程式一個，儲存在 `auth-profiles.json`）。
- **環境變數**（例如 `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **設定**（`models.providers.*.apiKey`、`tools.web.search.*`、`tools.web.fetch.firecrawl.*`、
  `memorySearch.*`、`talk.apiKey`）。
- **Skills**（`skills.entries.<name>.apiKey`），可能會將金鑰匯出到技能行程的環境變數。

## 可能花費金鑰的功能

### 1. 核心模型回應（聊天 + 工具）

每次回覆或工具呼叫都會使用**目前的模型提供者**（OpenAI、Anthropic 等）。這是
用量與成本的主要來源。 This is the
primary source of usage and cost.

價格設定請參閱 [Models](/providers/models)，顯示方式請參閱 [Token use & costs](/reference/token-use)。

### 2. 媒體理解（音訊 / 影像 / 影片）

Inbound media can be summarized/transcribed before the reply runs. This uses model/provider APIs.

- 音訊：OpenAI / Groq / Deepgram（現在在存在金鑰時**自動啟用**）。
- 影像：OpenAI / Anthropic / Google。
- 影片：Google。

請參閱 [Media understanding](/nodes/media-understanding)。

### 3. 記憶嵌入 + 語意搜尋

當設定為遠端提供者時，語意記憶搜尋會使用**嵌入 API**：

- `memorySearch.provider = "openai"` → OpenAI 嵌入
- `memorySearch.provider = "gemini"` → Gemini 嵌入
- `memorySearch.provider = "voyage"` → Voyage 嵌入
- 若本地嵌入失敗，可選擇回退到遠端提供者

你可以使用 `memorySearch.provider = "local"` 保持在本地（不使用 API）。

請參閱 [Memory](/concepts/memory)。

### 4. 網頁搜尋工具（Brave / 透過 OpenRouter 的 Perplexity）

`web_search` 會使用 API 金鑰，並可能產生用量費用：

- **Brave Search API**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
- **Perplexity**（透過 OpenRouter）：`PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`

**Brave 免費方案（相當慷慨）：**

- **每月 2,000 次請求**
- **每秒 1 次請求**
- **需要信用卡** 進行驗證（除非升級，否則不會收費）

請參閱 [Web tools](/tools/web)。

### 5. 網頁擷取工具（Firecrawl）

當存在 API 金鑰時，`web_fetch` 可能會呼叫 **Firecrawl**：

- `FIRECRAWL_API_KEY` 或 `tools.web.fetch.firecrawl.apiKey`

若未設定 Firecrawl，工具會回退為直接擷取 + 可讀性處理（不使用付費 API）。

請參閱 [Web tools](/tools/web)。

### 6. 提供者用量快照（status / health）

Some status commands call **provider usage endpoints** to display quota windows or auth health.
These are typically low-volume calls but still hit provider APIs:

- `openclaw status --usage`
- `openclaw models status --json`

請參閱 [Models CLI](/cli/models)。

### 7. 壓縮保護的摘要

The compaction safeguard can summarize session history using the **current model**, which
invokes provider APIs when it runs.

請參閱 [Session management + compaction](/reference/session-management-compaction)。

### 8. 模型掃描 / 探測

`openclaw models scan` 可探測 OpenRouter 模型，且在啟用探測時會使用 `OPENROUTER_API_KEY`。

請參閱 [Models CLI](/cli/models)。

### 9. Talk（語音）

當完成設定時，Talk 模式可能會呼叫 **ElevenLabs**：

- `ELEVENLABS_API_KEY` 或 `talk.apiKey`

請參閱 [Talk mode](/nodes/talk)。

### 10. Skills（第三方 API）

Skills 可以將 `apiKey` 儲存在 `skills.entries.<name>.apiKey` 關聯的環境變數名稱。 If a skill uses that key for external
APIs, it can incur costs according to the skill’s provider.

請參閱 [Skills](/tools/skills)。
