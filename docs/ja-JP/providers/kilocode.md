---
read_when:
    - 多くのLLMに対して単一のAPIキーを使いたい
    - OpenClawでKilo Gateway経由でモデルを実行したい
summary: Kilo Gatewayの統合APIを使用してOpenClawで多くのモデルにアクセスする
title: Kilo Gateway
x-i18n:
    generated_at: "2026-04-02T08:57:29Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 115bee6706d91eb977afbdc1d0830ff5ae67f812e6e8eff6d4456179611355b0
    source_path: providers/kilocode.md
    workflow: 15
---

# Kilo Gateway

Kilo Gatewayは、単一のエンドポイントとAPIキーの背後で多くのモデルにリクエストをルーティングする**統合API**を提供する。OpenAI互換のため、ほとんどのOpenAI SDKはベースURLを切り替えるだけで動作する。

## APIキーの取得

1. [app.kilo.ai](https://app.kilo.ai)にアクセスする
2. サインインまたはアカウントを作成する
3. API Keysに移動して新しいキーを生成する

## CLIセットアップ

```bash
openclaw onboard --kilocode-api-key <key>
```

または環境変数を設定する：

```bash
export KILOCODE_API_KEY="<your-kilocode-api-key>" # pragma: allowlist secret
```

## 設定スニペット

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo/auto" },
    },
  },
}
```

## デフォルトモデル

デフォルトのモデルは`kilocode/kilo/auto`で、タスクに基づいて最適な基盤モデルを自動的に選択するスマートルーティングモデルである：

- 計画、デバッグ、オーケストレーションタスクはClaude Opusにルーティングされる
- コード記述と探索タスクはClaude Sonnetにルーティングされる

## 利用可能なモデル

OpenClawは起動時にKilo Gatewayから利用可能なモデルを動的に検出する。
`/models kilocode`を使用して、アカウントで利用可能なモデルの完全なリストを確認できる。

Gateway上で利用可能なすべてのモデルは`kilocode/`プレフィックスで使用できる：

```
kilocode/kilo/auto              (default - smart routing)
kilocode/anthropic/claude-sonnet-4
kilocode/openai/gpt-5.2
kilocode/google/gemini-3-pro-preview
...and many more
```

## 注意事項

- モデル参照は`kilocode/<model-id>`の形式（例：`kilocode/anthropic/claude-sonnet-4`）。
- デフォルトモデル：`kilocode/kilo/auto`
- ベースURL：`https://api.kilo.ai/api/gateway/`
- その他のモデル／プロバイダーオプションについては、[/concepts/model-providers](/concepts/model-providers)を参照。
- Kilo Gatewayは内部でAPIキーを使用したBearerトークンを使用する。
