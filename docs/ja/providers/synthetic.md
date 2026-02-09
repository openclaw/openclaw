---
summary: "OpenClaw で Synthetic の Anthropic 互換 API を使用します"
read_when:
  - Synthetic をモデルプロバイダーとして使用したい場合
  - Synthetic の API キーまたはベース URL の設定が必要な場合
title: "Synthetic"
---

# Synthetic

合成は、Anthropic互換のエンドポイントを公開します。 Synthetic は Anthropic 互換のエンドポイントを提供します。OpenClaw はこれを
`synthetic` プロバイダーとして登録し、Anthropic Messages API を使用します。

## クイックスタート

1. `SYNTHETIC_API_KEY` を設定します（または以下のウィザードを実行します）。
2. オンボーディングを実行します。

```bash
openclaw onboard --auth-choice synthetic-api-key
```

デフォルトのモデルは次のように設定されています。

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 設定例

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

注記: OpenClaw の Anthropic クライアントは、ベース URL に `/v1` を付加します。そのため、
`https://api.synthetic.new/anthropic` を使用してください（`/anthropic/v1` は使用しないでください）。Synthetic が
ベース URL を変更した場合は、`models.providers.synthetic.baseUrl` を上書きしてください。 Synthetic が
のベース URL を変更した場合、`models.providers.synthetic.baseUrl` を上書きします。

## モデルカタログ

以下のすべてのモデルは、コスト `0`（入力／出力／キャッシュ）を使用します。

| モデル ID                                                 | コンテキストウィンドウ | 最大トークン | 推論    | 入力           |
| ------------------------------------------------------ | ----------- | ------ | ----- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000      | 65536  | false | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000      | 8192   | true  | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000      | 128000 | false | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000      | 8192   | false | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000      | 8192   | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000      | 8192   | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000      | 8192   | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000      | 8192   | false | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000      | 8192   | false | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000      | 8192   | false | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000      | 8192   | false | text         |
| `hf:openai/gpt-oss-120b`                               | 128000      | 8192   | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000      | 8192   | false | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000      | 8192   | false | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000      | 8192   | false | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000      | 128000 | false | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000      | 128000 | false | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000      | 8192   | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000      | 8192   | true  | text         |

## 注記

- モデル参照には `synthetic/<modelId>` を使用します。
- モデルの許可リスト（`agents.defaults.models`）を有効にしている場合は、使用予定のすべてのモデルを追加してください。
- プロバイダーのルールについては、「[Model providers](/concepts/model-providers)」を参照してください。
