---
summary: Run OpenClaw with vLLM (OpenAI-compatible local server)
read_when:
  - You want to run OpenClaw against a local vLLM server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: vLLM
---

# vLLM

vLLM 可以透過 **OpenAI 相容** 的 HTTP API 提供開源（以及部分自訂）模型服務。OpenClaw 可以使用 `openai-completions` API 連接到 vLLM。

當你啟用 `VLLM_API_KEY`（如果你的伺服器不強制驗證，任何值皆可）且未定義明確的 `models.providers.vllm` 專案時，OpenClaw 也能 **自動偵測** vLLM 上可用的模型。

## 快速開始

1. 啟動具備 OpenAI 相容伺服器的 vLLM。

你的基底 URL 應該要暴露 `/v1` 端點（例如 `/v1/models`、`/v1/chat/completions`）。vLLM 通常執行於：

- `http://127.0.0.1:8000/v1`

2. 啟用選項（若無驗證設定，任何值皆可）：

```bash
export VLLM_API_KEY="vllm-local"
```

3. 選擇模型（請替換為你的 vLLM 模型 ID）：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## 模型偵測（隱式提供者）

當設定了 `VLLM_API_KEY`（或存在驗證設定檔）且你 **未** 定義 `models.providers.vllm` 時，OpenClaw 將會查詢：

- `GET http://127.0.0.1:8000/v1/models`

…並將回傳的 ID 轉換成模型條目。

如果你明確設定了 `models.providers.vllm`，系統將跳過自動偵測，必須手動定義模型。

## 明確設定（手動模型）

在以下情況下使用明確設定：

- vLLM 執行在不同的主機/埠號。
- 你想要鎖定 `contextWindow`/`maxTokens` 的值。
- 你的伺服器需要真實的 API 金鑰（或你想要控制標頭）。

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

- 確認伺服器可連線：

```bash
curl http://127.0.0.1:8000/v1/models
```

- 如果請求因授權錯誤失敗，請設定與伺服器設定相符的真實 `VLLM_API_KEY`，或在 `models.providers.vllm` 下明確設定提供者。
