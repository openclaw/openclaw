---
summary: Use Venice AI privacy-focused models in OpenClaw
read_when:
  - You want privacy-focused inference in OpenClaw
  - You want Venice AI setup guidance
title: Venice AI
---

# Venice AI（Venice 重點介紹）

**Venice** 是我們專注隱私優先推論的 Venice 設定，提供可選的匿名化存取專有模型。

Venice AI 提供以隱私為核心的 AI 推論，支援無審查模型，並透過匿名代理存取主要專有模型。所有推論預設皆為私密—不會用您的資料做訓練，也不會記錄。

## 為什麼在 OpenClaw 使用 Venice

- **私密推論**，適用於開源模型（不記錄日誌）。
- 需要時可使用 **無審查模型**。
- 需要品質時，透過 **匿名化存取** 專有模型（Opus/GPT/Gemini）。
- 相容 OpenAI 的 `/v1` 端點。

## 隱私模式

Venice 提供兩種隱私等級 — 了解這點是選擇模型的關鍵：

| 模式       | 說明                                                                                         | 模型                                                       |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **私密**   | 完全私密。提示與回應 **絕不儲存或記錄**。為短暫性資料。                                      | Llama、Qwen、DeepSeek、Kimi、MiniMax、Venice Uncensored 等 |
| **匿名化** | 透過 Venice 代理，剝除元資料。底層提供者（OpenAI、Anthropic、Google、xAI）看到的是匿名請求。 | Claude、GPT、Gemini、Grok                                  |

## 功能特色

- **隱私優先**：可選「私密」（完全私密）或「匿名化」（代理）模式
- **無審查模型**：存取無內容限制的模型
- **主要模型存取**：透過 Venice 匿名代理使用 Claude、GPT、Gemini 和 Grok
- **相容 OpenAI API**：標準 `/v1` 端點，方便整合
- **串流支援**：✅ 全模型支援
- **函式呼叫**：✅ 部分模型支援（請確認模型能力）
- **視覺能力**：✅ 支援具視覺功能的模型
- **無硬性速率限制**：極端使用情況下可能會有公平使用的節流

## 設定說明

### 1. 取得 API 金鑰

1. 註冊帳號於 [venice.ai](https://venice.ai)
2. 前往 **設定 → API 金鑰 → 建立新金鑰**
3. 複製您的 API 金鑰（格式：`vapi_xxxxxxxxxxxx`）

### 2. 設定 OpenClaw

**選項 A：環境變數**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**選項 B：互動式設定（推薦）**

```bash
openclaw onboard --auth-choice venice-api-key
```

此操作將會：

1. 提示輸入您的 API 金鑰（或使用現有的 `VENICE_API_KEY`）
2. 顯示所有可用的 Venice 模型
3. 讓您選擇預設模型
4. 自動設定提供者

**選項 C：非互動式**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. 驗證設定

```bash
openclaw agent --model venice/kimi-k2-5 --message "Hello, are you working?"
```

## 模型選擇

設定完成後，OpenClaw 會顯示所有可用的 Venice 模型。請依需求選擇：

- **預設模型**：`venice/kimi-k2-5`，適合強化私密推理與視覺功能。
- **高效能選項**：`venice/claude-opus-4-6`，提供最強的匿名 Venice 路徑。
- **隱私**：選擇「private」模型以進行完全私密的推論。
- **效能**：選擇「anonymized」模型，透過 Venice 代理存取 Claude、GPT、Gemini。

您可以隨時更改預設模型：

```bash
openclaw models set venice/kimi-k2-5
openclaw models set venice/claude-opus-4-6
```

列出所有可用模型：

```bash
openclaw models list | grep venice
```

## 透過 `openclaw configure` 進行設定

1. 執行 `openclaw configure`
2. 選擇 **Model/auth**
3. 選擇 **Venice AI**

## 我應該使用哪個模型？

| 使用情境             | 推薦模型                         | 原因                                 |
| -------------------- | -------------------------------- | ------------------------------------ |
| **一般聊天（預設）** | `kimi-k2-5`                      | 強大的私有推理能力及視覺功能         |
| **整體最佳品質**     | `claude-opus-4-6`                | 最強的匿名 Venice 選項               |
| **隱私 + 程式碼**    | `qwen3-coder-480b-a35b-instruct` | 私有程式碼模型，具備大上下文能力     |
| **私有視覺**         | `kimi-k2-5`                      | 支援視覺且不離開私有模式             |
| **快速且便宜**       | `qwen3-4b`                       | 輕量推理模型                         |
| **複雜私有任務**     | `deepseek-v3.2`                  | 強大的推理能力，但不支援 Venice 工具 |
| **無審查**           | `venice-uncensored`              | 無內容限制                           |

## 可用模型（共 41 個）

### 私有模型（26 個）— 完全私有，無日誌紀錄

| 模型 ID                                | 名稱                                | 上下文 | 功能               |
| -------------------------------------- | ----------------------------------- | ------ | ------------------ |
| `kimi-k2-5`                            | Kimi K2.5                           | 256k   | 預設、推理、視覺   |
| `kimi-k2-thinking`                     | Kimi K2 Thinking                    | 256k   | 推理               |
| `llama-3.3-70b`                        | Llama 3.3 70B                       | 128k   | 一般用途           |
| `llama-3.2-3b`                         | Llama 3.2 3B                        | 128k   | 一般用途           |
| `hermes-3-llama-3.1-405b`              | Hermes 3 Llama 3.1 405B             | 128k   | 一般用途，工具停用 |
| `qwen3-235b-a22b-thinking-2507`        | Qwen3 235B Thinking                 | 128k   | 推理               |
| `qwen3-235b-a22b-instruct-2507`        | Qwen3 235B Instruct                 | 128k   | 一般用途           |
| `qwen3-coder-480b-a35b-instruct`       | Qwen3 Coder 480B                    | 256k   | 程式碼             |
| `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B Turbo              | 256k   | 程式碼             |
| `qwen3-5-35b-a3b`                      | Qwen3.5 35B A3B                     | 256k   | 推理、視覺         |
| `qwen3-next-80b`                       | Qwen3 Next 80B                      | 256k   | 一般用途           |
| `qwen3-vl-235b-a22b`                   | Qwen3 VL 235B (視覺)                | 256k   | 視覺               |
| `qwen3-4b`                             | Venice Small (Qwen3 4B)             | 32k    | 快速、推理         |
| `deepseek-v3.2`                        | DeepSeek V3.2                       | 160k   | 推理，工具停用     |
| `venice-uncensored`                    | Venice Uncensored (Dolphin-Mistral) | 32k    | 無審查，工具停用   |
| `mistral-31-24b`                       | Venice Medium (Mistral)             | 128k   | 視覺               |
| `google-gemma-3-27b-it`                | Google Gemma 3 27B Instruct         | 198k   | 視覺               |
| `openai-gpt-oss-120b`                  | OpenAI GPT OSS 120B                 | 128k   | 一般用途           |
| `nvidia-nemotron-3-nano-30b-a3b`       | NVIDIA Nemotron 3 Nano 30B          | 128k   | 一般用途           |
| `olafangensan-glm-4.7-flash-heretic`   | GLM 4.7 Flash Heretic               | 128k   | 推理               |
| `zai-org-glm-4.6`                      | GLM 4.6                             | 198k   | 一般用途           |
| `zai-org-glm-4.7`                      | GLM 4.7                             | 198k   | 推理               |
| `zai-org-glm-4.7-flash`                | GLM 4.7 Flash                       | 128k   | 推理               |
| `zai-org-glm-5`                        | GLM 5                               | 198k   | 推理               |
| `minimax-m21`                          | MiniMax M2.1                        | 198k   | 推理               |
| `minimax-m25`                          | MiniMax M2.5                        | 198k   | 推理               |

### 匿名模型（15 個）— 透過 Venice 代理

| 模型 ID                         | 名稱                            | 上下文 | 功能               |
| ------------------------------- | ------------------------------- | ------ | ------------------ |
| `claude-opus-4-6`               | Claude Opus 4.6 (透過 Venice)   | 1M     | 推理、視覺         |
| `claude-opus-4-5`               | Claude Opus 4.5 (透過 Venice)   | 198k   | 推理、視覺         |
| `claude-sonnet-4-6`             | Claude Sonnet 4.6 (透過 Venice) | 1M     | 推理、視覺         |
| `claude-sonnet-4-5`             | Claude Sonnet 4.5 (透過 Venice) | 198k   | 推理、視覺         |
| `openai-gpt-54`                 | GPT-5.4 (透過 Venice)           | 1M     | 推理、視覺         |
| `openai-gpt-53-codex`           | GPT-5.3 Codex (透過 Venice)     | 400k   | 推理、視覺、程式碼 |
| `openai-gpt-52`                 | GPT-5.2 (透過 Venice)           | 256k   | 推理               |
| `openai-gpt-52-codex`           | GPT-5.2 Codex (透過 Venice)     | 256k   | 推理、視覺、程式碼 |
| `openai-gpt-4o-2024-11-20`      | GPT-4o (透過 Venice)            | 128k   | 視覺               |
| `openai-gpt-4o-mini-2024-07-18` | GPT-4o Mini (透過 Venice)       | 128k   | 視覺               |
| `gemini-3-1-pro-preview`        | Gemini 3.1 Pro (透過 Venice)    | 1M     | 推理、視覺         |
| `gemini-3-pro-preview`          | Gemini 3 Pro (透過 Venice)      | 198k   | 推理、視覺         |
| `gemini-3-flash-preview`        | Gemini 3 Flash (透過 Venice)    | 256k   | 推理、視覺         |
| `grok-41-fast`                  | Grok 4.1 Fast (透過 Venice)     | 1M     | 推理、視覺         |
| `grok-code-fast-1`              | Grok Code Fast 1 (透過 Venice)  | 256k   | 推理、程式碼       |

## 模型發現

當設定 `VENICE_API_KEY` 時，OpenClaw 會自動從 Venice API 發現模型。若 API 無法連線，則會回退至靜態目錄。

`/models` 端點為公開（列出模型不需驗證），但推論需要有效的 API 金鑰。

## 串流與工具支援

| 功能          | 支援情況                                                   |
| ------------- | ---------------------------------------------------------- |
| **串流**      | ✅ 全部模型                                                |
| **函式呼叫**  | ✅ 大多數模型（請參考 API 中的 `supportsFunctionCalling`） |
| **視覺/影像** | ✅ 標示有「視覺」功能的模型                                |
| **JSON 模式** | ✅ 透過 `response_format` 支援                             |

## 價格

Venice 採用點數制。請參考 [venice.ai/pricing](https://venice.ai/pricing) 了解最新費率：

- **私有模型**：通常費用較低
- **匿名化模型**：類似直接 API 價格 + 少量 Venice 手續費

## 比較：Venice 與直接 API

| 專案     | Venice（匿名化）   | 直接 API     |
| -------- | ------------------ | ------------ |
| **隱私** | 去除元資料，匿名化 | 連結您的帳號 |
| **延遲** | +10-50ms（代理）   | 直接連線     |
| **功能** | 支援大部分功能     | 全功能       |
| **計費** | Venice 點數        | 供應商計費   |

## 使用範例

bash

# 使用預設私有模型

openclaw agent --model venice/kimi-k2-5 --message "快速健康檢查"

# 透過 Venice 使用 Claude Opus（匿名化）

openclaw agent --model venice/claude-opus-4-6 --message "摘要此任務"

# 使用無審查模型

openclaw agent --model venice/venice-uncensored --message "草擬選項"

# 使用帶圖片的視覺模型

openclaw agent --model venice/qwen3-vl-235b-a22b --message "檢視附加圖片"

# 使用程式碼模型

openclaw agent --model venice/qwen3-coder-480b-a35b-instruct --message "重構此函式"

## 疑難排解

### API 金鑰無法識別

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

請確認金鑰是以 `vapi_` 開頭。

### 模型不可用

Venice 模型目錄會動態更新。執行 `openclaw models list` 以查看目前可用的模型。有些模型可能暫時離線。

### 連線問題

Venice API 位於 `https://api.venice.ai/api/v1`。請確保您的網路允許 HTTPS 連線。

## 設定檔範例

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/kimi-k2-5" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2-5",
            name: "Kimi K2.5",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 65536,
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
- [價格](https://venice.ai/pricing)
- [狀態](https://status.venice.ai)
