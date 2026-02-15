---
summary: "透過 Ollama 執行 OpenClaw (本機 LLM 執行環境)"
read_when:
  - 您想透過 Ollama 執行本機模型來執行 OpenClaw
  - 您需要 Ollama 設定與配置指南
title: "Ollama"
---

# Ollama

Ollama 是一個本機 LLM 執行環境，讓您可以在您的機器上輕鬆執行開源模型。OpenClaw 整合了 Ollama 的原生 API (`/api/chat`)，支援串流傳輸和工具呼叫，並且當您選擇使用 `OLLAMA_API_KEY` (或驗證設定檔) 且未定義明確的 `models.providers.ollama` 項目時，可以**自動探索具備工具能力的模型**。

## 快速開始

1. 安裝 Ollama: [https://ollama.ai](https://ollama.ai)

2. 下載模型：

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. 為 OpenClaw 啟用 Ollama (任何值皆可；Ollama 不需要真正的金鑰)：

```bash
# 設定環境變數
export OLLAMA_API_KEY="ollama-local"

# 或在您的設定檔案中配置
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. 使用 Ollama 模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## 模型探索 (隱式供應商)

當您設定 `OLLAMA_API_KEY` (或驗證設定檔) 且**未**定義 `models.providers.ollama` 時，OpenClaw 會從本機 Ollama 實例 `http://127.0.0.1:11434` 探索模型：

- 查詢 `/api/tags` 和 `/api/show`
- 只保留回報 `tools` 功能的模型
- 當模型回報 `thinking` 時，標記為 `reasoning`
- 當可用時，從 `model_info["<arch>.context_length"]` 讀取 `contextWindow`
- 將 `maxTokens` 設定為上下文視窗的 10 倍
- 將所有費用設定為 `0`

這避免了手動模型條目，同時使目錄與 Ollama 的功能保持一致。

要查看有哪些模型可用：

```bash
ollama list
openclaw models list
```

要新增模型，只需使用 Ollama 下載即可：

```bash
ollama pull mistral
```

新模型將被自動探索並可供使用。

如果您明確設定 `models.providers.ollama`，則會跳過自動探索，並且您必須手動定義模型 (詳見下方)。

## 設定

### 基本設定 (隱式探索)

啟用 Ollama 最簡單的方式是透過環境變數：

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 明確設定 (手動模型)

在以下情況使用明確配置：

- Ollama 在另一個主機/埠上執行。
- 您想強制使用特定的上下文視窗或模型列表。
- 您想包含不回報工具支援的模型。

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

如果已設定 `OLLAMA_API_KEY`，您可以省略供應商項目中的 `apiKey`，OpenClaw 將會填入以進行可用性檢查。

### 自訂基礎 URL (明確配置)

如果 Ollama 在不同的主機或埠上執行 (明確配置會停用自動探索，因此請手動定義模型)：

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434",
      },
    },
  },
}
```

### 模型選擇

一旦設定完成，所有您的 Ollama 模型都將可用：

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

## 進階

### 推理模型

當 Ollama 在 `/api/show` 中回報 `thinking` 時，OpenClaw 會將模型標記為具備推理能力。

```bash
ollama pull deepseek-r1:32b
```

### 模型費用

Ollama 是免費的並在本機執行，因此所有模型費用都設定為 $0。

### 串流傳輸設定

OpenClaw 的 Ollama 整合預設使用**原生的 Ollama API** (`/api/chat`)，該 API 完全支援同時進行串流傳輸和工具呼叫。無需特殊設定。

#### 傳統 OpenAI 相容模式

如果您需要改用 OpenAI 相容端點 (例如，在僅支援 OpenAI 格式的代理背後)，請明確設定 `api: "openai-completions"`：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

請注意：OpenAI 相容端點可能不支援同時進行串流傳輸 + 工具呼叫。您可能需要在模型設定中，使用 `params: { streaming: false }` 來停用串流傳輸。

### 上下文視窗

對於自動探索的模型，OpenClaw 會在可用時使用 Ollama 回報的上下文視窗，否則會預設為 `8192`。您可以在明確的供應商配置中覆寫 `contextWindow` 和 `maxTokens`。

## 疑難排解

### 未偵測到 Ollama

請確保 Ollama 正在執行，並且您已設定 `OLLAMA_API_KEY` (或驗證設定檔)，且**未**定義明確的 `models.providers.ollama` 項目：

```bash
ollama serve
```

並且 API 可存取：

```bash
curl http://localhost:11434/api/tags
```

### 無可用模型

OpenClaw 只會自動探索回報工具支援的模型。如果您的模型未列出，則可能是：

- 下載一個具備工具能力的模型，或者
- 在 `models.providers.ollama` 中明確定義模型。

要新增模型：

```bash
ollama list  # 查看已安裝的模型
ollama pull gpt-oss:20b  # 下載一個具備工具能力的模型
ollama pull llama3.3     # 或另一個模型
```

### 連線被拒

請檢查 Ollama 是否在正確的埠上執行：

```bash
# 檢查 Ollama 是否正在執行
ps aux | grep ollama

# 或重新啟動 Ollama
ollama serve
```

## 另請參閱

- [模型供應商](/concepts/model-providers) - 所有供應商概述
- [模型選擇](/concepts/models) - 如何選擇模型
- [設定](/gateway/configuration) - 完整設定參考
