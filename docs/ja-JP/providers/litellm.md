---
read_when:
    - OpenClawをLiteLLMプロキシ経由でルーティングしたい
    - LiteLLMを通じたコスト追跡、ログ記録、またはモデルルーティングが必要
summary: LiteLLM Proxyを通じてOpenClawを実行し、統合モデルアクセスとコスト追跡を実現する
title: LiteLLM
x-i18n:
    generated_at: "2026-04-02T08:57:47Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: cad99b0febc53dccab928ea8739951ffcb0636cffbf688f9e3c909cbcf2a87e5
    source_path: providers/litellm.md
    workflow: 15
---

# LiteLLM

[LiteLLM](https://litellm.ai)は、100以上のモデルプロバイダーに統合APIを提供するオープンソースのLLMゲートウェイである。OpenClawをLiteLLM経由でルーティングすることで、コスト追跡の一元化、ログ記録、OpenClawの設定を変更せずにバックエンドを切り替える柔軟性が得られる。

## OpenClawでLiteLLMを使う理由

- **コスト追跡** — すべてのモデルにおけるOpenClawの正確な支出を確認できる
- **モデルルーティング** — 設定変更なしでClaude、GPT-4、Gemini、Bedrockを切り替えられる
- **仮想キー** — OpenClaw用に支出制限付きのキーを作成できる
- **ログ記録** — デバッグ用のリクエスト／レスポンス完全ログ
- **フォールバック** — プライマリプロバイダーがダウンした場合の自動フェイルオーバー

## クイックスタート

### オンボーディング経由

```bash
openclaw onboard --auth-choice litellm-api-key
```

### 手動セットアップ

1. LiteLLM Proxyを起動する：

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. OpenClawをLiteLLMに向ける：

```bash
export LITELLM_API_KEY="your-litellm-key"

openclaw
```

以上で完了。OpenClawはLiteLLM経由でルーティングされるようになる。

## 設定

### 環境変数

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### 設定ファイル

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

## 仮想キー

OpenClaw用に支出制限付きの専用キーを作成する：

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

生成されたキーを`LITELLM_API_KEY`として使用する。

## モデルルーティング

LiteLLMはモデルリクエストを異なるバックエンドにルーティングできる。LiteLLMの`config.yaml`で設定する：

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

OpenClawは`claude-opus-4-6`をリクエストし続け、LiteLLMがルーティングを処理する。

## 使用状況の確認

LiteLLMのダッシュボードまたはAPIで確認する：

```bash
# キー情報
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# 支出ログ
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 注意事項

- LiteLLMはデフォルトで`http://localhost:4000`で動作する
- OpenClawはOpenAI互換の`/v1/chat/completions`エンドポイント経由で接続する
- OpenClawのすべての機能はLiteLLM経由で動作する — 制限はない

## 関連項目

- [LiteLLM Docs](https://docs.litellm.ai)
- [モデルプロバイダー](/concepts/model-providers)
