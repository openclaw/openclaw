---
summary: "使用 vLLM 執行 OpenClaw (與 OpenAI 相容的本地伺服器)"
read_when:
  - 您希望針對本地 vLLM 伺服器執行 OpenClaw
  - 您希望透過自己的模型使用與 OpenAI 相容的 /v1 端點
title: "vLLM"
---

# vLLM

vLLM 可以透過**與 OpenAI 相容**的 HTTP API 提供開源（和一些客製化）模型服務。OpenClaw 可以使用 `openai-completions` API 連接到 vLLM。

當您使用 `VLLM_API_KEY` 啟用（如果您的伺服器不強制進行身份驗證，任何值都可以）並且未定義明確的 `models.providers.vllm` 項目時，OpenClaw 還可以從 vLLM **自動探索**可用的模型。

## 快速開始

1. 啟動具有 OpenAI 相容伺服器的 vLLM。

您的基本 URL 應公開 `/v1` 端點（例如 `/v1/models`、`/v1/chat/completions`）。vLLM 通常在以下位置運行：

- `http://127.0.0.1:8000/v1`

2. 啟用（如果未設定身份驗證，任何值都可以）：

```bash
export VLLM_API_KEY="vllm-local"
```

3. 選擇一個模型（替換為您的 vLLM 模型 ID 之一）：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## 模型探索（隱式供應商）

當設定 `VLLM_API_KEY`（或存在身份驗證設定檔）並且您**未**定義 `models.providers.vllm` 時，OpenClaw 將會查詢：

- `GET http://127.0.0.1:8000/v1/models`

…並將返回的 ID 轉換為模型項目。

如果您明確設定 `models.providers.vllm`，則會跳過自動探索，並且您必須手動定義模型。

## 明確設定（手動模型）

在以下情況下使用明確設定：

- vLLM 在不同的主機/連接埠上執行。
- 您希望固定 `contextWindow`/`maxTokens` 值。
- 您的伺服器需要真正的 API 金鑰（或者您希望控制請求標頭）。

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 疑難排解

- 檢查伺服器是否可達：

```bash
curl http://127.0.0.1:8000/v1/models
```

- 如果請求因身份驗證錯誤而失敗，請設定一個符合您伺服器設定的真實 `VLLM_API_KEY`，或在 `models.providers.vllm` 下明確設定供應商。
