---
summary: "在 OpenClaw 中使用注重隱私的 Venice AI 模型"
read_when:
  - 你希望在 OpenClaw 中進行注重隱私的推論
  - 你需要 Venice AI 的設定指引
title: "Venice AI"
---

# Venice AI（Venice 精選）

**Venice** 是我們精選的 Venice 設定，提供以隱私為優先的推論，並可選擇透過匿名方式存取專有模型。

Venice AI 提供注重隱私的 AI 推論，支援無審查模型，並可透過其匿名代理存取主要的專有模型。所有推論預設皆為私密——不使用你的資料進行訓練，也不會記錄。 All inference is private by default—no training on your data, no logging.

## 為什麼在 OpenClaw 中選擇 Venice

- **私密推論**：適用於開源模型（不記錄）。
- **無審查模型**：在你需要時使用。
- **匿名存取**：在重視品質時，透過匿名方式存取專有模型（Opus/GPT/Gemini）。
- 相容 OpenAI 的 `/v1` 端點。

## 隱私模式

Venice 提供兩種隱私等級——了解這一點是選擇模型的關鍵：

| 模式             | Description                                                                                                                                                             | 模型                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Private**    | 完全私有。 Prompts/responses are **never stored or logged**. Ephemeral.                                                                      | Llama、Qwen、DeepSeek、Venice Uncensored 等 |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests. | Claude、GPT、Gemini、Grok、Kimi、MiniMax     |

## 功能

- **注重隱私**：在「private」（完全私密）與「anonymized」（代理）模式之間選擇
- **無審查模型**：可存取沒有內容限制的模型
- **主流模型存取**：透過 Venice 的匿名代理使用 Claude、GPT-5.2、Gemini、Grok
- **相容 OpenAI 的 API**：標準 `/v1` 端點，易於整合
- **串流**：✅ 所有模型皆支援
- **函式呼叫**：✅ 部分模型支援（請查看模型能力）
- **視覺**：✅ 具備視覺能力的模型支援
- **無硬性速率限制**：極端使用情況可能套用公平使用的節流

## 設定

### 1. 取得 API 金鑰

1. 在 [venice.ai](https://venice.ai) 註冊
2. 前往 **Settings → API Keys → Create new key**
3. 複製你的 API 金鑰（格式：`vapi_xxxxxxxxxxxx`）

### 2) 設定 OpenClaw

**選項 A：環境變數**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**選項 B：互動式設定（建議）**

```bash
openclaw onboard --auth-choice venice-api-key
```

這將會：

1. 提示你輸入 API 金鑰（或使用既有的 `VENICE_API_KEY`）
2. 顯示所有可用的 Venice 模型
3. 讓你選擇預設模型
4. 自動設定提供者

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

完成設定後，OpenClaw 會顯示所有可用的 Venice 模型。請依需求選擇： Pick based on your needs:

- **預設（我們的選擇）**：`venice/llama-3.3-70b`，提供私密且均衡的效能。
- **整體最佳品質**：`venice/claude-opus-45`，適合高難度任務（Opus 仍然最強）。
- **隱私**：選擇「private」模型以進行完全私密的推論。
- **能力**：選擇「anonymized」模型，透過 Venice 的代理存取 Claude、GPT、Gemini。

隨時變更你的預設模型：

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

## 我該使用哪個模型？

| 使用情境               | 建議模型                             | 原因               |
| ------------------ | -------------------------------- | ---------------- |
| **一般聊天**           | `llama-3.3-70b`                  | 全方位表現佳，完全私密      |
| **整體最佳品質**         | `claude-opus-45`                 | Opus 在高難度任務上仍然最強 |
| **隱私 + Claude 品質** | `claude-opus-45`                 | 透過匿名代理提供最佳推理     |
| **程式設計**           | `qwen3-coder-480b-a35b-instruct` | 為程式碼最佳化，262k 上下文 |
| **視覺任務**           | `qwen3-vl-235b-a22b`             | 最佳的私密視覺模型        |
| **無審查**            | `venice-uncensored`              | 無內容限制            |
| **快速 + 低成本**       | `qwen3-4b`                       | 輕量且仍具能力          |
| **複雜推理**           | `deepseek-v3.2`                  | 推理能力強，私密         |

## 可用模型（共 25 個）

### Private 模型（15）— 完全私密，不記錄

| Model ID                         | 名稱                                      | 上下文（tokens） | 功能         |
| -------------------------------- | --------------------------------------- | ----------- | ---------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k        | 一般用途       |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k        | 快速、輕量      |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k        | 複雜任務       |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                     | 131k        | 推理         |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                     | 131k        | 一般用途       |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                        | 262k        | 程式碼        |
| `qwen3-next-80b`                 | Qwen3 Next 80B                          | 262k        | 一般用途       |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                           | 262k        | 視覺         |
| `qwen3-4b`                       | Venice Small（Qwen3 4B）                  | 32k         | 快速、推理      |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k        | 推理         |
| `venice-uncensored`              | Venice Uncensored                       | 32k         | Uncensored |
| `mistral-31-24b`                 | Venice Medium（Mistral）                  | 131k        | 視覺         |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                    | 202k        | 視覺         |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                     | 131k        | 一般用途       |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k        | 推理、多語言     |

### Anonymized 模型（10）— 透過 Venice 代理

| Model ID                 | 原始模型                              | 上下文（tokens） | 功能     |
| ------------------------ | --------------------------------- | ----------- | ------ |
| `claude-opus-45`         | Claude Opus 4.5   | 202k        | 推理、視覺  |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k        | 推理、視覺  |
| `openai-gpt-52`          | GPT-5.2           | 262k        | 推理     |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k        | 推理、視覺  |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k        | 推理、視覺  |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k        | 推理、視覺  |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k        | 推理、視覺  |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k        | 推理、程式碼 |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k        | 推理     |
| `minimax-m21`            | MiniMax M2.1      | 202k        | 推理     |

## 模型探索

當設定 `VENICE_API_KEY` 時，OpenClaw 會自動從 Venice API 探索模型。若 API 無法連線，則會回退至靜態目錄。 If the API is unreachable, it falls back to a static catalog.

`/models` 端點為公開端點（列出模型不需要驗證），但進行推論需要有效的 API 金鑰。

## 串流與工具支援

| 功能          | 支援狀態                                         |
| ----------- | -------------------------------------------- |
| **串流**      | ✅ 所有模型                                       |
| **函式呼叫**    | ✅ 多數模型（請在 API 中查看 `supportsFunctionCalling`） |
| **視覺／圖片**   | ✅ 標示為「Vision」功能的模型                           |
| **JSON 模式** | ✅ 透過 `response_format` 支援                    |

## 定價

Venice 採用點數制系統。 Venice 採用以點數為基礎的系統。請至 [venice.ai/pricing](https://venice.ai/pricing) 查看最新費率：

- **Private 模型**：通常成本較低
- **Anonymized 模型**：與直接 API 定價相近，另加少量 Venice 費用

## 比較：Venice 與直接 API

| 面向     | Venice（Anonymized） | 直接 API  |
| ------ | ------------------ | ------- |
| **隱私** | 中繼資料已移除並匿名化        | 與你的帳戶連結 |
| **延遲** | +10–50ms（代理）       | 直接      |
| **功能** | 多數功能支援             | 完整功能    |
| **計費** | Venice 點數          | 提供者計費   |

## 使用範例

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## 疑難排解

### API 金鑰無法辨識

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

請確認金鑰以 `vapi_` 開頭。

### 模型無法使用

The Venice model catalog updates dynamically. Venice 的模型目錄會動態更新。請執行 `openclaw models list` 查看目前可用的模型。部分模型可能暫時離線。 Some models may be temporarily offline.

### 連線問題

Venice API 位於 `https://api.venice.ai/api/v1`。請確認你的網路允許 HTTPS 連線。 Ensure your network allows HTTPS connections.

## 設定檔範例

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
