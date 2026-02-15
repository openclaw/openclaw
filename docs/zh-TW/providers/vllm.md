---
summary: "使用 OpenClaw 執行 vLLM（OpenAI 相容的本地伺服器）"
read_when:
  - 你想針對本地 vLLM 伺服器執行 OpenClaw
  - 你想透過自己的模型使用 OpenAI 相容的 /v1 端點
title: "vLLM"
---

# vLLM

vLLM 可以透過 **OpenAI 相容**的 HTTP API 提供開源（以及一些自定義）模型。OpenClaw 可以使用 `openai-completions` API 連接到 vLLM。

當你啟用 `VLLM_API_KEY`（如果你的伺服器不強制執行驗證，則任何值都可以）且未定義明確的 `models.providers.vllm` 項目時，OpenClaw 還可以從 vLLM **自動探索**可用的模型。

## 快速開始

1. 使用 OpenAI 相容的伺服器啟動 vLLM。

你的基礎 URL 應公開 `/v1` 端點（例如 `/v1/models`、`/v1/chat/completions`）。vLLM 通常執行於：

- `http://127.0.0.1:8000/v1`

2. 啟用（如果未設定驗證，則任何值都可以）：

```bash
export VLLM_API_KEY="vllm-local"
```

3. 選擇模型（替換為你的其中一個 vLLM 模型 ID）：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## 模型探索（隱含供應商）

當 `VLLM_API_KEY` 已設定（或存在驗證設定檔）且你**沒有**定義 `models.providers.vllm` 時，OpenClaw 將查詢：

- `GET http://127.0.0.1:8000/v1/models`

……並將返回的 ID 轉換為模型項目。

如果你明確設定了 `models.providers.vllm`，則會跳過自動探索，你必須手動定義模型。

## 明確設定（手動模型）

在以下情況下使用明確設定：

- vLLM 在不同的主機/連接埠上執行。
- 你想固定 `contextWindow`/`maxTokens` 的值。
- 你的伺服器需要真實的 API 金鑰（或者你想控制標頭）。

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

- 檢查伺服器是否可連線：

```bash
curl http://127.0.0.1:8000/v1/models
```

- 如果請求失敗並出現驗證錯誤，請設定一個與你的伺服器設定相符的真實 `VLLM_API_KEY`，或在 `models.providers.vllm` 下明確設定供應商。
