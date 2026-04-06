---
read_when:
    - OpenClaw で Hugging Face Inference を使用したい場合
    - HF トークンの環境変数や CLI 認証の選択肢が必要な場合
summary: Hugging Face Inference のセットアップ（認証 + モデル選択）
title: Hugging Face (Inference)
x-i18n:
    generated_at: "2026-04-02T08:57:47Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: e62b74915c9a26ab21954abcd9c03442cdd2133fba3371ddb9bcfc3a3458a002
    source_path: providers/huggingface.md
    workflow: 15
---

# Hugging Face (Inference)

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) は、単一のルーター API を通じて OpenAI 互換のチャット補完を提供します。1つのトークンで多くのモデル（DeepSeek、Llama など）にアクセスできます。OpenClaw は **OpenAI 互換エンドポイント**（チャット補完のみ）を使用します。テキストから画像、エンベディング、音声については [HF inference clients](https://huggingface.co/docs/api-inference/quicktour) を直接使用してください。

- プロバイダー: `huggingface`
- 認証: `HUGGINGFACE_HUB_TOKEN` または `HF_TOKEN`（**Make calls to Inference Providers** 権限を持つきめ細かいトークン）
- API: OpenAI 互換 (`https://router.huggingface.co/v1`)
- 課金: 単一の HF トークン。[料金](https://huggingface.co/docs/inference-providers/pricing)はプロバイダーの料金に従い、無料枠あり。

## クイックスタート

1. [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) で **Make calls to Inference Providers** 権限を持つきめ細かいトークンを作成します。
2. オンボーディングを実行し、プロバイダーのドロップダウンで **Hugging Face** を選択してから、プロンプトが表示されたら API キーを入力します:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. **Default Hugging Face model** ドロップダウンで、使用したいモデルを選択します（有効なトークンがある場合、リストは Inference API から読み込まれます。それ以外の場合は組み込みリストが表示されます）。選択したモデルがデフォルトモデルとして保存されます。
4. デフォルトモデルは後から設定で変更することもできます:

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## 非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

これにより `huggingface/deepseek-ai/DeepSeek-R1` がデフォルトモデルとして設定されます。

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行されている場合、`HUGGINGFACE_HUB_TOKEN` または `HF_TOKEN`
がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` や
`env.shellEnv` で設定）。

## モデルディスカバリーとオンボーディングドロップダウン

OpenClaw は **Inference エンドポイントを直接呼び出して** モデルを検出します:

```bash
GET https://router.huggingface.co/v1/models
```

（オプション: 完全なリストを取得するには `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` または `$HF_TOKEN` を送信します。一部のエンドポイントは認証なしではサブセットのみを返します。）レスポンスは OpenAI 形式の `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }` です。

Hugging Face API キーを設定すると（オンボーディング、`HUGGINGFACE_HUB_TOKEN`、または `HF_TOKEN` 経由）、OpenClaw はこの GET リクエストを使用して利用可能なチャット補完モデルを検出します。**対話型セットアップ**では、トークンを入力した後、そのリストから取得された **Default Hugging Face model** ドロップダウンが表示されます（リクエストが失敗した場合は組み込みカタログが使用されます）。ランタイム時（例: Gateway ゲートウェイ起動時）、キーが存在する場合、OpenClaw は再度 **GET** `https://router.huggingface.co/v1/models` を呼び出してカタログを更新します。リストは組み込みカタログ（コンテキストウィンドウやコストなどのメタデータ用）とマージされます。リクエストが失敗した場合やキーが設定されていない場合は、組み込みカタログのみが使用されます。

## モデル名と編集可能なオプション

- **API からの名前:** モデルの表示名は、API が `name`、`title`、または `display_name` を返す場合、**GET /v1/models から取得**されます。それ以外の場合はモデル ID から導出されます（例: `deepseek-ai/DeepSeek-R1` → 「DeepSeek R1」）。
- **表示名のオーバーライド:** 設定でモデルごとにカスタムラベルを設定できるため、CLI や UI で好みの表示にできます:

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (fast)" },
        "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (cheap)" },
      },
    },
  },
}
```

- **プロバイダー / ポリシーの選択:** **モデル ID** にサフィックスを付けて、ルーターがバックエンドを選択する方法を指定します:
  - **`:fastest`** — 最高スループット（ルーターが選択。プロバイダーの選択は**ロック**されます — 対話型のバックエンド選択は表示されません）。
  - **`:cheapest`** — 出力トークンあたりの最低コスト（ルーターが選択。プロバイダーの選択は**ロック**されます）。
  - **`:provider`** — 特定のバックエンドを強制（例: `:sambanova`、`:together`）。

  **:cheapest** または **:fastest** を選択した場合（例: オンボーディングのモデルドロップダウンで）、プロバイダーはロックされます: ルーターがコストまたは速度で決定し、オプションの「特定のバックエンドを優先」ステップは表示されません。これらは `models.providers.huggingface.models` に別のエントリとして追加するか、サフィックス付きの `model.primary` を設定できます。また、[Inference Provider settings](https://hf.co/settings/inference-providers) でデフォルトの順序を設定することもできます（サフィックスなし = その順序を使用）。

- **設定のマージ:** `models.providers.huggingface.models`（例: `models.json` 内）の既存エントリは、設定がマージされる際に保持されます。そのため、そこで設定したカスタムの `name`、`alias`、またはモデルオプションは保持されます。

## モデル ID と設定例

モデル参照は `huggingface/<org>/<model>` の形式を使用します（Hub スタイルの ID）。以下のリストは **GET** `https://router.huggingface.co/v1/models` からのものです。カタログにはさらに多くのモデルが含まれている場合があります。

**ID の例（inference エンドポイントから）:**

| モデル                  | 参照（`huggingface/` をプレフィックスとして付与）    |
| ---------------------- | ----------------------------------- |
| DeepSeek R1            | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2          | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B               | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct    | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B              | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct  | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B           | `openai/gpt-oss-120b`               |
| GLM 4.7                | `zai-org/GLM-4.7`                   |
| Kimi K2.5              | `moonshotai/Kimi-K2.5`              |

モデル ID に `:fastest`、`:cheapest`、または `:provider`（例: `:together`、`:sambanova`）を付加できます。デフォルトの順序は [Inference Provider settings](https://hf.co/settings/inference-providers) で設定してください。完全なリストは [Inference Providers](https://huggingface.co/docs/inference-providers) および **GET** `https://router.huggingface.co/v1/models` を参照してください。

### 完全な設定例

**DeepSeek R1 をプライマリ、Qwen をフォールバック:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-R1",
        fallbacks: ["huggingface/Qwen/Qwen3-8B"],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
      },
    },
  },
}
```

**Qwen をデフォルトに、:cheapest と :fastest バリアント付き:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3-8B" },
      models: {
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
        "huggingface/Qwen/Qwen3-8B:cheapest": { alias: "Qwen3 8B (cheapest)" },
        "huggingface/Qwen/Qwen3-8B:fastest": { alias: "Qwen3 8B (fastest)" },
      },
    },
  },
}
```

**DeepSeek + Llama + GPT-OSS にエイリアス付き:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-V3.2",
        fallbacks: [
          "huggingface/meta-llama/Llama-3.3-70B-Instruct",
          "huggingface/openai/gpt-oss-120b",
        ],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-V3.2": { alias: "DeepSeek V3.2" },
        "huggingface/meta-llama/Llama-3.3-70B-Instruct": { alias: "Llama 3.3 70B" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```

**:provider で特定のバックエンドを強制:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**ポリシーサフィックス付きの複数の Qwen および DeepSeek モデル:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest" },
      models: {
        "huggingface/Qwen/Qwen2.5-7B-Instruct": { alias: "Qwen2.5 7B" },
        "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest": { alias: "Qwen2.5 7B (cheap)" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (fast)" },
        "huggingface/meta-llama/Llama-3.1-8B-Instruct": { alias: "Llama 3.1 8B" },
      },
    },
  },
}
```
