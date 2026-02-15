---
summary: "透過 LiteLLM Proxy 執行 OpenClaw 以進行統一的模型存取與費用追蹤"
read_when:
  - 您想透過 LiteLLM 代理轉發 OpenClaw
  - 您需要透過 LiteLLM 進行費用追蹤、記錄或模型路由
---

# LiteLLM

[LiteLLM](https://litellm.ai) 是一個開源的 LLM Gateway，為超過 100 家模型供應商提供統一的 API。透過 LiteLLM 轉發 OpenClaw，可以獲得集中化的費用追蹤、日誌記錄，並能在不更改 OpenClaw 設定的情況下靈活切換後端。

## 為什麼要在 OpenClaw 使用 LiteLLM？

- **費用追蹤** — 精確查看 OpenClaw 在所有模型上的支出
- **模型路由** — 無需更改設定即可在 Claude、GPT-4、Gemini、Bedrock 之間切換
- **虛擬金鑰** — 為 OpenClaw 建立具有支出限制的金鑰
- **日誌記錄** — 用於除錯的完整請求/回應日誌
- **容錯機制** — 如果主要供應商故障，會自動進行容錯移轉

## 快速開始

### 透過新手導覽

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 手動設定

1. 啟動 LiteLLM Proxy：

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. 將 OpenClaw 指向 LiteLLM：

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

就這麼簡單。OpenClaw 現在會透過 LiteLLM 進行路由。

## 設定

### 環境變數

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### 設定檔案

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

為 OpenClaw 建立一個具有支出限制的專用金鑰：

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

將產生的金鑰用作 `LITELLM_API_KEY`。

## 模型路由

LiteLLM 可以將模型請求路由到不同的後端。在您的 LiteLLM `config.yaml` 中進行設定：

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: gpt-4o
    litellm_params:
      model: gpt-4o
      api_key: os.environ/OPENAI_API_KEY
```

OpenClaw 持續請求 `claude-opus-4-6` — 而由 LiteLLM 處理路由。

## 查看使用情況

查看 LiteLLM 的儀表板或 API：

```bash
# 金鑰資訊
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# 支出日誌
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 注意事項

- LiteLLM 預設在 `http://localhost:4000` 執行
- OpenClaw 透過相容於 OpenAI 的 `/v1/chat/completions` 端點進行連接
- 所有 OpenClaw 功能在 LiteLLM 下皆可正常運作 — 無任何限制

## 延伸閱讀

- [LiteLLM Docs](https://docs.litellm.ai)
- [模型供應商](/concepts/model-providers)
