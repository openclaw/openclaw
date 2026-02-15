---
summary: "使用 Ollama (本地 LLM 執行階段) 執行 OpenClaw"
read_when:
  - 您想透過 Ollama 使用本地模型執行 OpenClaw
  - 您需要 Ollama 的安裝與設定指南
title: "Ollama"
---

# Ollama

Ollama 是一個本地 LLM 執行階段，可以輕鬆在您的機器上執行開源模型。OpenClaw 與 Ollama 的原生 API (`/api/chat`) 整合，支援串流與工具呼叫，並可在您啟用 `OLLAMA_API_KEY` (或身份驗證設定檔) 且未定義明確的 `models.providers.ollama` 項目時，**自動探索具備工具能力的模型**。

## 快速開始

1. 安裝 Ollama：[https://ollama.ai](https://ollama.ai)

2. 下載模型：

```bash
ollama pull gpt-oss:20b
# 或
ollama pull llama3.3
# 或
ollama pull qwen2.5-coder:32b
# 或
ollama pull deepseek-r1:32b
```

3. 為 OpenClaw 啟用 Ollama (任何數值皆可；Ollama 不需要真實的金鑰)：

```bash
# 設定環境變數
export OLLAMA_API_KEY="ollama-local"

# 或在您的設定檔中設定
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

## 模型探索 (隱含供應商)

當您設定 `OLLAMA_API_KEY` (或身份驗證設定檔) 且**未**定義 `models.providers.ollama` 時，OpenClaw 會從位於 `http://127.0.0.1:11434` 的本地 Ollama 執行體探索模型：

- 查詢 `/api/tags` 與 `/api/show`
- 僅保留回報具備 `tools` 能力的模型
- 當模型回報 `thinking` 時標記為 `reasoning`
- 可用時從 `model_info["<arch>.context_length"]` 讀取 `contextWindow`
- 將 `maxTokens` 設定為內容視窗的 10 倍
- 將所有成本設定為 `0`

這可以避免手動輸入模型項目，同時讓目錄與 Ollama 的能力保持一致。

查看可用模型：

```bash
ollama list
openclaw models list
```

若要新增模型，只需使用 Ollama 下載即可：

```bash
ollama pull mistral
```

新模型將會自動被探索並可供使用。

如果您明確設定了 `models.providers.ollama`，則會跳過自動探索，您必須手動定義模型 (詳見下文)。

## 設定

### 基本設定 (隱含探索)

啟用 Ollama 最簡單的方法是透過環境變數：

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 明確設定 (手動定義模型)

在以下情況使用明確設定：

- Ollama 執行於其他主機/通訊埠。
- 您想強制指定特定的內容視窗或模型列表。
- 您想包含未回報工具支援的模型。

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

如果已設定 `OLLAMA_API_KEY`，您可以省略供應商項目中的 `apiKey`，OpenClaw 會自動填入以進行可用性檢查。

### 自定義 Base URL (明確設定)

如果 Ollama 執行於不同的主機或通訊埠 (明確設定會停用自動探索，因此請手動定義模型)：

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

設定完成後，您所有的 Ollama 模型皆可使用：

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

當 Ollama 在 `/api/show` 中回報 `thinking` 時，OpenClaw 會將模型標記為具備推理能力：

```bash
ollama pull deepseek-r1:32b
```

### 模型成本

Ollama 是免費且在本地執行的，因此所有模型成本皆設定為 $0。

### 串流設定

OpenClaw 的 Ollama 整合預設使用 **原生 Ollama API** (`/api/chat`)，其完全支援同時進行串流與工具呼叫。不需要特殊設定。

#### 舊版 OpenAI 相容模式

如果您需要改用 OpenAI 相容的端點 (例如：在僅支援 OpenAI 格式的代理伺服器後方)，請明確設定 `api: "openai-completions"`：

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

注意：OpenAI 相容端點可能不支援同時進行串流與工具呼叫。您可能需要在模型設定中透過 `params: { streaming: false }` 停用串流。

### 內容視窗

對於自動探索的模型，OpenClaw 會在可用時使用 Ollama 回報的內容視窗，否則預設為 `8192`。您可以在明確的供應商設定中覆蓋 `contextWindow` 與 `maxTokens`。

## 疑難排解

### 未偵測到 Ollama

請確保 Ollama 正在執行，且您已設定 `OLLAMA_API_KEY` (或身份驗證設定檔)，並且**未**定義明確的 `models.providers.ollama` 項目：

```bash
ollama serve
```

並確認 API 可存取：

```bash
curl http://localhost:11434/api/tags
```

### 無可用模型

OpenClaw 僅會自動探索回報工具支援的模型。如果您的模型未列出，請：

- 下載具備工具能力的模型，或
- 在 `models.providers.ollama` 中明確定義模型。

若要新增模型：

```bash
ollama list  # 查看已安裝項目
ollama pull gpt-oss:20b  # 下載具備工具能力的模型
ollama pull llama3.3     # 或其他模型
```

### 連線被拒絕 (Connection refused)

檢查 Ollama 是否在正確的通訊埠上執行：

```bash
# 檢查 Ollama 是否正在執行
ps aux | grep ollama

# 或重新啟動 Ollama
ollama serve
```

## 延伸閱讀

- [模型供應商](/concepts/model-providers) - 所有供應商概覽
- [模型選擇](/concepts/models) - 如何選擇模型
- [設定](/gateway/configuration) - 完整設定參考
