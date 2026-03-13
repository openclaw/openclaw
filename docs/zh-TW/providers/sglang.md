---
summary: Run OpenClaw with SGLang (OpenAI-compatible self-hosted server)
read_when:
  - You want to run OpenClaw against a local SGLang server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: SGLang
---

# SGLang

SGLang 可以透過 **OpenAI 相容** 的 HTTP API 提供開源模型服務。
OpenClaw 可以使用 `openai-completions` API 連接到 SGLang。

當你選擇啟用 `SGLANG_API_KEY`（如果你的伺服器不強制驗證，任何值皆可）且未定義明確的 `models.providers.sglang` 專案時，
OpenClaw 也能 **自動偵測** SGLang 上可用的模型。

## 快速開始

1. 啟動具備 OpenAI 相容伺服器的 SGLang。

你的基底 URL 應該要暴露 `/v1` 端點（例如 `/v1/models`、`/v1/chat/completions`）。SGLang 通常執行於：

- `http://127.0.0.1:30000/v1`

2. 選擇啟用（若無驗證設定，任何值皆可）：

```bash
export SGLANG_API_KEY="sglang-local"
```

3. 執行入門流程並選擇 `SGLang`，或直接設定模型：

```bash
openclaw onboard
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "sglang/your-model-id" },
    },
  },
}
```

## 模型偵測（隱含提供者）

當設定了 `SGLANG_API_KEY`（或存在驗證設定檔）且你 **未** 定義 `models.providers.sglang` 時，OpenClaw 將會查詢：

- `GET http://127.0.0.1:30000/v1/models`

並將返回的 ID 轉換為模型條目。

如果你明確設定了 `models.providers.sglang`，將會跳過自動偵測，必須手動定義模型。

## 明確設定（手動模型）

在以下情況下使用明確設定：

- SGLang 執行在不同的主機/埠號。
- 你想要鎖定 `contextWindow`/`maxTokens` 的值。
- 你的伺服器需要真實的 API 金鑰（或你想控制標頭）。

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local SGLang Model",
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
curl http://127.0.0.1:30000/v1/models
```

- 如果請求因授權錯誤失敗，請設定與你的伺服器設定相符的真實 `SGLANG_API_KEY`，或在 `models.providers.sglang` 下明確設定提供者。
