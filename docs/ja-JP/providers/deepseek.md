---
read_when:
    - OpenClawでDeepSeekを使用したい場合
    - APIキーの環境変数またはCLI認証オプションが必要な場合
summary: DeepSeekのセットアップ（認証 + モデル選択）
x-i18n:
    generated_at: "2026-04-02T08:37:49Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c43199a17dd473c41696f6e8228d52356990d3e90d640e35401159c92f2885e2
    source_path: providers/deepseek.md
    workflow: 15
---

# DeepSeek

[DeepSeek](https://www.deepseek.com)は、OpenAI互換APIを備えた強力なAIモデルを提供します。

- プロバイダー: `deepseek`
- 認証: `DEEPSEEK_API_KEY`
- API: OpenAI互換

## クイックスタート

APIキーを設定します（推奨: Gateway ゲートウェイ用に保存）:

```bash
openclaw onboard --auth-choice deepseek-api-key
```

APIキーの入力を求められ、`deepseek/deepseek-chat` がデフォルトモデルとして設定されます。

## 非対話式の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice deepseek-api-key \
  --deepseek-api-key "$DEEPSEEK_API_KEY" \
  --skip-health \
  --accept-risk
```

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行される場合、`DEEPSEEK_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。

## 利用可能なモデル

| モデルID            | 名前                     | タイプ    | コンテキスト |
| ------------------- | ------------------------ | --------- | ------------ |
| `deepseek-chat`     | DeepSeek Chat (V3.2)     | 汎用      | 128K         |
| `deepseek-reasoner` | DeepSeek Reasoner (V3.2) | 推論      | 128K         |

- **deepseek-chat** は非思考モードのDeepSeek-V3.2に対応します。
- **deepseek-reasoner** は思考連鎖推論を備えた思考モードのDeepSeek-V3.2に対応します。

APIキーは [platform.deepseek.com](https://platform.deepseek.com/api_keys) で取得できます。
