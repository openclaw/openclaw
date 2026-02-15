---
summary: "透過 LiteLLM Proxy 執行 OpenClaw，以實現統一模型存取和成本追蹤"
read_when:
  - 您想透過 LiteLLM proxy 路由 OpenClaw
  - 您需要透過 LiteLLM 進行成本追蹤、日誌記錄或模型路由
---

# LiteLLM

[LiteLLM](https://litellm.ai) 是一個開源的 LLM Gateway，提供 100 多個模型供應商的統一 API。透過 LiteLLM 路由 OpenClaw，以獲得集中式的成本追蹤、日誌記錄以及無需更改 OpenClaw 設定即可切換後端的靈活性。

## 為什麼要將 LiteLLM 與 OpenClaw 搭配使用？

- **成本追蹤** — 準確查看 OpenClaw 在所有模型上的支出
- **模型路由** — 無需更改設定即可在 Claude、GPT-4、Gemini、Bedrock 之間切換
- **虛擬金鑰** — 為 OpenClaw 建立具有支出限制的金鑰
- **日誌記錄** — 用於偵錯的完整請求/回應日誌
- **備援** — 如果您的主要供應商發生故障，則自動容錯移轉

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

就這樣。OpenClaw 現在透過 LiteLLM 進行路由。

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

使用生成的金鑰作為 `LITELLM_API_KEY`。

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

OpenClaw 繼續請求 `claude-opus-4-6` — LiteLLM 處理路由。

## 查看使用情況

檢查 LiteLLM 的儀表板或 API：

```bash
# Key info
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# Spend logs
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 說明

- LiteLLM 預設在 `http://localhost:4000` 上執行
- OpenClaw 透過 OpenAI 相容的 `/v1/chat/completions` 端點連接
- 所有 OpenClaw 功能都透過 LiteLLM 運作 — 沒有限制

## 參閱

- [LiteLLM 文件](https://docs.litellm.ai)
- [模型供應商](/concepts/model-providers)
