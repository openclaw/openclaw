---
read_when:
    - Syntheticをモデルプロバイダーとして使用したい場合
    - SyntheticのAPIキーまたはベースURLの設定が必要な場合
summary: SyntheticのAnthropic互換APIをOpenClawで使用する
title: Synthetic
x-i18n:
    generated_at: "2026-04-02T07:50:57Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 3a2adb0b831babe3e88b027772167748764d85ee72d402ff759571420a91757f
    source_path: providers/synthetic.md
    workflow: 15
---

# Synthetic

SyntheticはAnthropic互換のエンドポイントを公開しています。OpenClawはこれを`synthetic`プロバイダーとして登録し、Anthropic Messages APIを使用します。

## クイックセットアップ

1. `SYNTHETIC_API_KEY`を設定します（または以下のウィザードを実行します）。
2. オンボーディングを実行します：

```bash
openclaw onboard --auth-choice synthetic-api-key
```

デフォルトのモデルは以下に設定されます：

```
synthetic/hf:MiniMaxAI/MiniMax-M2.5
```

## 設定例

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.5": { alias: "MiniMax M2.5" } },
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
            id: "hf:MiniMaxAI/MiniMax-M2.5",
            name: "MiniMax M2.5",
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

注意：OpenClawのAnthropicクライアントはベースURLに`/v1`を付加するため、`https://api.synthetic.new/anthropic`を使用してください（`/anthropic/v1`ではありません）。SyntheticがベースURLを変更した場合は、`models.providers.synthetic.baseUrl`をオーバーライドしてください。

## モデルカタログ

以下のすべてのモデルはコスト`0`（入力/出力/キャッシュ）を使用します。

| モデルID                                                 | コンテキストウィンドウ | 最大トークン数 | 推論 | 入力         |
| ------------------------------------------------------ | -------------- | ---------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.5`                            | 192000         | 65536      | false     | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192       | true      | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000     | false     | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192       | false     | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192       | false     | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192       | false     | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192       | false     | text         |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192       | false     | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000     | false     | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000     | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192       | true      | text         |

## 注意事項

- モデル参照は`synthetic/<modelId>`の形式を使用します。
- モデル許可リスト（`agents.defaults.models`）を有効にする場合は、使用予定のすべてのモデルを追加してください。
- プロバイダーのルールについては、[モデルプロバイダー](/concepts/model-providers)を参照してください。
