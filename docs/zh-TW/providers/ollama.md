---
summary: Run OpenClaw with Ollama (cloud and local models)
read_when:
  - You want to run OpenClaw with cloud or local models via Ollama
  - You need Ollama setup and configuration guidance
title: Ollama
---

# Ollama

Ollama 是一個本地 LLM 執行環境，讓你輕鬆在自己的機器上執行開源模型。OpenClaw 整合了 Ollama 的原生 API (`/api/chat`)，支援串流與工具呼叫，並且當你選擇使用 `OLLAMA_API_KEY`（或授權設定檔）且未明確定義 `models.providers.ollama` 專案時，能自動偵測本地 Ollama 模型。

<Warning>
**遠端 Ollama 使用者**：請勿在 OpenClaw 中使用 `/v1` 這個與 OpenAI 相容的 URL (`http://host:11434/v1`)。這會導致工具呼叫失效，模型可能會將原始工具 JSON 當作純文字輸出。請改用 Ollama 原生 API URL：`baseUrl: "http://host:11434"`（不含 `/v1`）。
</Warning>

## 快速開始

### 新手導覽精靈（推薦）

設定 Ollama 最快速的方式是透過新手導覽精靈：

```bash
openclaw onboard
```

從提供者清單中選擇 **Ollama**。精靈會：

1. 詢問你的 Ollama 實例可連接的基底 URL（預設為 `http://127.0.0.1:11434`）。
2. 讓你選擇 **Cloud + Local**（雲端模型與本地模型）或 **Local**（僅本地模型）。
3. 如果你選擇 **Cloud + Local** 且尚未登入 ollama.com，會開啟瀏覽器登入流程。
4. 偵測可用模型並建議預設值。
5. 若選擇的模型本地尚未下載，會自動拉取。

也支援非互動模式：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --accept-risk
```

可選擇指定自訂基底 URL 或模型：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

### 手動設定

1. 安裝 Ollama：[https://ollama.com/download](https://ollama.com/download)

2. 如果您想要本地推論，請拉取本地模型：

```bash
ollama pull glm-4.7-flash
# or
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
```

3. 如果您也想使用雲端模型，請登入：

```bash
ollama signin
```

4. 執行入門流程並選擇 `Ollama`：

```bash
openclaw onboard
```

- `Local`：僅限本地模型
- `Cloud + Local`：本地模型加上雲端模型
- 雲端模型如 `kimi-k2.5:cloud`、`minimax-m2.5:cloud` 和 `glm-5:cloud` **不需要**本地 `ollama pull`

OpenClaw 目前建議：

- 本地預設：`glm-4.7-flash`
- 雲端預設：`kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`

5. 如果您偏好手動設定，直接為 OpenClaw 啟用 Ollama（任意值皆可；Ollama 不需要真實金鑰）：

bash

# 設定環境變數

export OLLAMA_API_KEY="ollama-local"

# 或在您的設定檔中設定

openclaw config set models.providers.ollama.apiKey "ollama-local"

6. 檢查或切換模型：

```bash
openclaw models list
openclaw models set ollama/glm-4.7-flash
```

7. 或在設定檔中設置預設值：

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/glm-4.7-flash" },
    },
  },
}
```

## 模型發現（隱式提供者）

當你設定 `OLLAMA_API_KEY`（或授權設定檔）且**未**定義 `models.providers.ollama` 時，OpenClaw 會從本地 Ollama 實例 `http://127.0.0.1:11434` 發現模型：

- 查詢 `/api/tags`
- 盡力使用 `/api/show` 查找以讀取 `contextWindow`（若可用）
- 以模型名稱啟發式方法標記 `reasoning`（`r1`、`reasoning`、`think`）
- 將 `maxTokens` 設為 OpenClaw 使用的預設 Ollama 最大 token 限制
- 將所有成本設為 `0`

這樣可以避免手動輸入模型，同時保持目錄與本地 Ollama 實例同步。

要查看可用的模型：

```bash
ollama list
openclaw models list
```

要新增模型，只需用 Ollama 拉取：

```bash
ollama pull mistral
```

新模型會自動被發現並可使用。

如果你明確設定 `models.providers.ollama`，則會跳過自動發現，必須手動定義模型（見下方說明）。

## 設定

### 基本設定（隱式發現）

啟用 Ollama 最簡單的方式是透過環境變數：

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 明確設定（手動模型）

在以下情況下使用明確設定：

- Ollama 執行在其他主機或埠號。
- 你想強制指定特定的上下文視窗或模型清單。
- 你想完全手動定義模型。

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

如果設定了 `OLLAMA_API_KEY`，你可以在提供者條目中省略 `apiKey`，OpenClaw 將自動填入以進行可用性檢查。

### 自訂基底 URL（明確設定）

如果 Ollama 執行在不同的主機或埠號（明確設定會停用自動偵測，因此需手動定義模型）：

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // No /v1 - use native Ollama API URL
        api: "ollama", // Set explicitly to guarantee native tool-calling behavior
      },
    },
  },
}
```

<Warning>
請勿在 URL 中加入 `/v1`。`/v1` 路徑使用與 OpenAI 相容的模式，工具呼叫不可靠。請使用不帶路徑後綴的 Ollama 基底 URL。
</Warning>

### 模型選擇

設定完成後，所有 Ollama 模型皆可使用：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## 雲端模型

雲端模型讓你可以同時執行雲端託管的模型（例如 `kimi-k2.5:cloud`、`minimax-m2.5:cloud`、`glm-5:cloud`）與本地模型。

要使用雲端模型，請在初始設定時選擇 **Cloud + Local** 模式。設定精靈會檢查你是否已登入，必要時會開啟瀏覽器進行登入流程。如果無法驗證身份，設定精靈將回退至本地模型預設。

您也可以直接在 [ollama.com/signin](https://ollama.com/signin) 登入。

## 進階

### 推理模型

OpenClaw 預設將名稱如 `deepseek-r1`、`reasoning` 或 `think` 的模型視為具備推理能力：

```bash
ollama pull deepseek-r1:32b
```

### 模型費用

Ollama 是免費且本地執行的，因此所有模型費用皆設定為 $0。

### 串流設定

OpenClaw 的 Ollama 整合預設使用 **原生 Ollama API** (`/api/chat`)，完全支援串流與工具呼叫同時進行，無需特別設定。

#### 傳統 OpenAI 相容模式

<Warning>
**在 OpenAI 相容模式下，工具呼叫不可靠。** 僅當您需要 OpenAI 格式以用於代理，且不依賴原生工具呼叫行為時，才使用此模式。
</Warning>

如果您需要改用 OpenAI 相容端點（例如在只支援 OpenAI 格式的代理後方），請明確設定 `api: "openai-completions"`：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: true, // default: true
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

此模式可能不支援串流與工具呼叫同時進行，您可能需要在模型設定中使用 `params: { streaming: false }` 來停用串流。

當與 Ollama 一起使用 `api: "openai-completions"` 時，OpenClaw 預設會注入 `options.num_ctx`，以避免 Ollama 默默回退到 4096 的上下文視窗大小。如果您的代理或上游拒絕未知的 `options` 欄位，請停用此行為：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: false,
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

### 上下文視窗

對於自動偵測的模型，OpenClaw 會使用 Ollama 報告的上下文視窗（若有提供），否則會回退到 OpenClaw 使用的預設 Ollama 上下文視窗。你可以在明確的提供者設定中覆寫 `contextWindow` 和 `maxTokens`。

## 疑難排解

### 未偵測到 Ollama

請確認 Ollama 正在執行，且你已設定 `OLLAMA_API_KEY`（或授權設定檔），並且**未**定義明確的 `models.providers.ollama` 專案：

```bash
ollama serve
```

且 API 可正常存取：

```bash
curl http://localhost:11434/api/tags
```

### 沒有可用的模型

如果你的模型未列出，請執行以下其中一項：

- 將模型拉取到本地，或
- 在 `models.providers.ollama` 中明確定義該模型。

新增模型的方法：

```bash
ollama list  # See what's installed
ollama pull glm-4.7-flash
ollama pull gpt-oss:20b
ollama pull llama3.3     # Or another model
```

### 連線被拒絕

檢查 Ollama 是否在正確的埠口執行：

bash

# 檢查 Ollama 是否正在執行

ps aux | grep ollama

# 或重新啟動 Ollama

ollama serve

## 參考資料

- [模型提供者](/concepts/model-providers) - 所有提供者總覽
- [模型選擇](/concepts/models) - 如何挑選模型
- [設定](/gateway/configuration) - 完整設定參考
