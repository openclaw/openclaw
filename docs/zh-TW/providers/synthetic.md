---
summary: "在 OpenClaw 中使用 Synthetic 的 Anthropic 相容 API"
read_when:
  - 您想將 Synthetic 作為模型供應商使用
  - 您需要設定 Synthetic API 金鑰或基礎 URL
title: "Synthetic"
---

# Synthetic

Synthetic 提供與 Anthropic 相容的端點。OpenClaw 將其註冊為 `synthetic` 供應商並使用 Anthropic Messages API。

## 快速開始

1. 設定 `SYNTHETIC_API_KEY`（或執行下方的精靈）。
2. 執行新手導覽：

```bash
openclaw onboard --auth-choice synthetic-api-key
```

預設模型設定為：

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 設定範例

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

注意：OpenClaw 的 Anthropic 用戶端會在基礎 URL 後加上 `/v1`，因此請使用 `https://api.synthetic.new/anthropic`（而不是 `/anthropic/v1`）。如果 Synthetic 更改了其基礎 URL，請覆寫 `models.providers.synthetic.baseUrl`。

## 模型目錄

以下所有模型的費用均為 `0`（輸入/輸出/快取）。

| 模型 ID                                                | 內容視窗 | 最大 Token | 推理  | 輸入        |
| ------------------------------------------------------ | -------- | ---------- | ----- | ----------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000   | 65536      | false | 文字        |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000   | 8192       | true  | 文字        |
| `hf:zai-org/GLM-4.7`                                   | 198000   | 128000     | false | 文字        |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000   | 8192       | false | 文字        |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000   | 8192       | false | 文字        |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000   | 8192       | false | 文字        |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000   | 8192       | false | 文字        |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000   | 8192       | false | 文字        |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000   | 8192       | false | 文字        |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000   | 8192       | false | 文字        |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000   | 8192       | false | 文字        |
| `hf:openai/gpt-oss-120b`                               | 128000   | 8192       | false | 文字        |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000   | 8192       | false | 文字        |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000   | 8192       | false | 文字        |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000   | 8192       | false | 文字 + 圖片 |
| `hf:zai-org/GLM-4.5`                                   | 128000   | 128000     | false | 文字        |
| `hf:zai-org/GLM-4.6`                                   | 198000   | 128000     | false | 文字        |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000   | 8192       | false | 文字        |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000   | 8192       | true  | 文字        |

## 注意事項

- 模型引用使用 `synthetic/<modelId>`。
- 如果您啟用了模型許可名單 (`agents.defaults.models`)，請新增您打算使用的所有模型。
- 有關供應商規則，請參閱[模型供應商](/concepts/model-providers)。
