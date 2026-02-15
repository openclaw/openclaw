---
summary: "在 OpenClaw 中使用 Venice AI 注重隱私的模型"
read_when:
  - 您想在 OpenClaw 中進行注重隱私的推論
  - 您想獲得 Venice AI 設定指南
title: "Venice AI"
---

# Venice AI (Venice 亮點)

**Venice** 是我們強調的 Venice 設定，用於實現隱私優先的推論，並可選匿名存取專有模型。

Venice AI 提供注重隱私的 AI 推論，支援未審查的模型，並透過其匿名代理存取主要的專有模型。所有推論預設都是私密的—不對您的資料進行訓練，也不會記錄。

## 為何在 OpenClaw 中使用 Venice

- **私密推論** 適用於開源模型（不記錄）。
- 在您需要時使用**未審查的模型**。
- 在品質至關重要時，透過匿名方式**存取**專有模型（Opus/GPT/Gemini）。
- 相容 OpenAI 的 `/v1` 端點。

## 隱私模式

Venice 提供兩種隱私等級—理解這一點對於選擇模型至關重要：

| 模式           | 說明                                                                                                          | 模型                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **私密**    | 完全私密。提示/回應**從不儲存或記錄**。臨時性。                                          | Llama, Qwen, DeepSeek, Venice Uncensored, 等。 |
| **匿名化** | 透過 Venice 代理，並剝離中繼資料。底層供應商 (OpenAI, Anthropic) 收到匿名請求。 | Claude, GPT, Gemini, Grok, Kimi, MiniMax       |

## 功能

- **注重隱私**：選擇「私密」（完全私密）或「匿名化」（代理）模式
- **未審查的模型**：存取沒有內容限制的模型
- **主要模型存取**：透過 Venice 的匿名代理使用 Claude, GPT-5.2, Gemini, Grok
- **相容 OpenAI 的 API**：標準 `/v1` 端點，方便整合
- **串流傳輸**：✅ 所有模型均支援
- **函式呼叫**：✅ 支援特定模型（請查看模型功能）
- **視覺**：✅ 支援具有視覺功能的模型
- **無硬性速率限制**：極端使用情況下可能會應用公平使用節流

## 設定

### 1. 取得 API 金鑰

1. 在 [venice.ai](https://venice.ai) 註冊
2. 前往 **Settings → API Keys → Create new key**
3. 複製您的 API 金鑰（格式：`vapi_xxxxxxxxxxxx`）

### 2. 設定 OpenClaw

**選項 A：環境變數**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**選項 B：互動式設定（建議）**

```bash
openclaw onboard --auth-choice venice-api-key
```

這將：

1. 提示您輸入 API 金鑰（或使用現有的 `VENICE_API_KEY`）
2. 顯示所有可用的 Venice 模型
3. 讓您選擇您的預設模型
4. 自動設定供應商

**選項 C：非互動式**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. 驗證設定

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## 模型選擇

設定後，OpenClaw 會顯示所有可用的 Venice 模型。根據您的需求進行選擇：

- **預設（我們的選擇）**：`venice/llama-3.3-70b`，用於私密、平衡的效能。
- **最佳整體品質**：`venice/claude-opus-45`，用於困難的工作（Opus 仍然是最強大的）。
- **隱私**：選擇「私密」模型以進行完全私密的推論。
- **功能**：選擇「匿名化」模型以透過 Venice 的代理存取 Claude, GPT, Gemini。

隨時更改您的預設模型：

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

列出所有可用模型：

```bash
openclaw models list | grep venice
```

## 透過 `openclaw configure` 設定

1. 執行 `openclaw configure`
2. 選擇 **Model/auth**
3. 選擇 **Venice AI**

## 我應該使用哪個模型？

| 使用案例                     | 推薦模型                | 原因                                       |
| ---------------------------- | -------------------------------- | ----------------------------------------- |
| **一般聊天**             | `llama-3.3-70b`                  | 全面且私密            |
| **最佳整體品質**     | `claude-opus-45`                 | Opus 仍然是處理困難任務最強大的模型 |
| **隱私 + Claude 品質** | `claude-opus-45`                 | 透過匿名代理提供最佳推理       |
| **編碼**                   | `qwen3-coder-480b-a35b-instruct` | 針對編碼優化，262k 上下文              |
| **視覺任務**             | `qwen3-vl-235b-a22b`             | 最佳私密視覺模型                 |
| **未審查**               | `venice-uncensored`              | 無內容限制                   |
| **快速 + 便宜**             | `qwen3-4b`                       | 輕量級，仍然有能力                |
| **複雜推理**        | `deepseek-v3.2`                  | 強大推理能力，私密                 |

## 可用模型 (共 25 個)

### 私密模型 (15 個) — 完全私密，不記錄

| 模型 ID                         | 名稱                    | 上下文 (tokens) | 功能                |
| -------------------------------- | ----------------------- | ---------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k             | 一般                 |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k             | 快速，輕量級       |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k             | 複雜任務           |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k             | 推理               |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k             | 一般                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k             | 編碼                    |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k             | 一般                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k             | 視覺                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | 快速，推理         |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k             | 推理               |
| `venice-uncensored`              | Venice Uncensored       | 32k              | 未審查              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k             | 視覺                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k             | 視覺                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k             | 一般                 |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k             | 推理，多語言 |

### 匿名化模型 (10 個) — 透過 Venice 代理

| 模型 ID                 | 原始          | 上下文 (tokens) | 功能          |
| ------------------------ | ----------------- | ---------------- | ----------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k             | 推理，視覺 |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k             | 推理，視覺 |
| `openai-gpt-52`          | GPT-5.2           | 262k             | 推理         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k             | 推理，視覺 |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k             | 推理，視覺 |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k             | 推理，視覺 |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k             | 推理，視覺 |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k             | 推理，編碼   |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k             | 推理         |
| `minimax-m21`            | MiniMax M2.1      | 202k             | 推理         |

## 模型探索

當設定 `VENICE_API_KEY` 時，OpenClaw 會自動從 Venice API 探索模型。如果 API 無法連接，它會回退到靜態目錄。

`/models` 端點是公開的（列出時無需驗證），但推論需要有效的 API 金鑰。

## 串流傳輸與工具支援

| 功能              | 支援                                                 |
| -------------------- | ------------------------------------------------------- |
| **串流傳輸**        | ✅ 所有模型                                           |
| **函式呼叫** | ✅ 大多數模型（請查看 API 中的 `supportsFunctionCalling`） |
| **視覺/圖像**    | ✅ 標記有「視覺」功能的模型                  |
| **JSON 模式**        | ✅ 透過 `response_format` 支援                      |

## 定價

Venice 使用基於點數的系統。請查看 [venice.ai/pricing](https://venice.ai/pricing) 獲取當前費率：

- **私密模型**：通常成本較低
- **匿名化模型**：與直接 API 定價相似 + 少量的 Venice 費用

## 比較：Venice 與直接 API

| 方面       | Venice（匿名化）           | 直接 API          |
| ------------ | ----------------------------- | ------------------- |
| **隱私**  | 中繼資料被剝離，匿名化 | 您的帳戶已連結 |
| **延遲**  | +10-50ms (代理)              | 直接              |
| **功能** | 大多數功能支援       | 完整功能       |
| **計費**  | Venice 點數                | 供應商計費    |

## 使用範例

```bash
# 使用預設私密模型
openclaw chat --model venice/llama-3.3-70b

# 透過 Venice 使用 Claude (匿名化)
openclaw chat --model venice/claude-opus-45

# 使用未審查模型
openclaw chat --model venice/venice-uncensored

# 使用具有圖像的視覺模型
openclaw chat --model venice/qwen3-vl-235b-a22b

# 使用編碼模型
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## 疑難排解

### API 金鑰未被識別

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

確保金鑰以 `vapi_` 開頭。

### 模型不可用

Venice 模型目錄會動態更新。執行 `openclaw models list` 以查看目前可用的模型。某些模型可能暫時離線。

### 連線問題

Venice API 位於 `https://api.venice.ai/api/v1`。確保您的網路允許 HTTPS 連線。

## 設定檔案範例

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 連結

- [Venice AI](https://venice.ai)
- [API 文件](https://docs.venice.ai)
- [定價](https://venice.ai/pricing)
- [狀態](https://status.venice.ai)
