---
summary: Run OpenClaw through LiteLLM Proxy for unified model access and cost tracking
read_when:
  - You want to route OpenClaw through a LiteLLM proxy
  - "You need cost tracking, logging, or model routing through LiteLLM"
---

# LiteLLM

[LiteLLM](https://litellm.ai) 是一個開源的 LLM 閘道，提供統一的 API 連接超過 100 個模型供應商。透過 LiteLLM 路由 OpenClaw，可實現集中化的成本追蹤、日誌記錄，並且能在不更改 OpenClaw 設定的情況下靈活切換後端。

## 為什麼要搭配 OpenClaw 使用 LiteLLM？

- **成本追蹤** — 精確查看 OpenClaw 在所有模型上的花費
- **模型路由** — 無需更改設定即可在 Claude、GPT-4、Gemini、Bedrock 間切換
- **虛擬金鑰** — 為 OpenClaw 建立有消費上限的金鑰
- **日誌記錄** — 完整的請求/回應日誌，方便除錯
- **備援機制** — 當主要供應商故障時自動切換備援

## 快速開始

### 透過註冊導引

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 手動設定

1. 啟動 LiteLLM Proxy：

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. 指定 OpenClaw 使用 LiteLLM：

bash
export LITELLM_API_KEY="your-litellm-key"

openclaw

完成。OpenClaw 現在會透過 LiteLLM 路由。

## 設定說明

### 環境變數

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### 設定檔

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-opus-4-6" },
    },
  },
}
```

## 虛擬金鑰

為 OpenClaw 建立專用金鑰並設定花費限制：

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "openclaw",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

使用產生的金鑰作為 `LITELLM_API_KEY`。

## 模型路由

LiteLLM 可以將模型請求路由到不同的後端。在你的 LiteLLM `config.yaml` 中進行設定：

yaml
model_list:

- model_name: claude-opus-4-6
  litellm_params:
  model: claude-opus-4-6
  api_key: os.environ/ANTHROPIC_API_KEY

- model_name: gpt-4o
  litellm_params:
  model: gpt-4o
  api_key: os.environ/OPENAI_API_KEY

OpenClaw 持續請求 `claude-opus-4-6` — LiteLLM 負責路由。

## 查看使用狀況

查看 LiteLLM 的儀表板或 API：

bash

# 主要資訊

curl "http://localhost:4000/key/info" \
 -H "Authorization: Bearer sk-litellm-key"

# 消費紀錄

curl "http://localhost:4000/spend/logs" \
 -H "Authorization: Bearer $LITELLM_MASTER_KEY"

## 備註

- LiteLLM 預設執行於 `http://localhost:4000`
- OpenClaw 透過相容 OpenAI 的 `/v1/chat/completions` 端點連接
- 所有 OpenClaw 功能皆可透過 LiteLLM 使用 — 無任何限制

## 參考資料

- [LiteLLM 文件](https://docs.litellm.ai)
- [模型供應商](/concepts/model-providers)
