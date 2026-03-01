---
summary: "`openclaw onboard` の CLI リファレンス（インタラクティブオンボーディングウィザード）"
read_when:
  - Gateway、ワークスペース、認証、チャンネル、スキルのガイド付きセットアップ
title: "onboard"
---

# `openclaw onboard`

インタラクティブオンボーディングウィザード（ローカルまたはリモート Gateway セットアップ）です。

## 関連ガイド

- CLI オンボーディングハブ: [オンボーディングウィザード（CLI）](/start/wizard)
- オンボーディングの概要: [オンボーディングの概要](/start/onboarding-overview)
- CLI オンボーディングリファレンス: [CLI オンボーディングリファレンス](/start/wizard-cli-reference)
- CLI オートメーション: [CLI オートメーション](/start/wizard-cli-automation)
- macOS オンボーディング: [オンボーディング（macOS アプリ）](/start/onboarding)

## 例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

非インタラクティブでカスタムプロバイダーを使用する場合:

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --secret-input-mode plaintext \
  --custom-compatibility openai
```

`--custom-api-key` は非インタラクティブモードではオプションです。省略した場合、オンボーディングは `CUSTOM_API_KEY` を確認します。

プロバイダーキーをプレーンテキストではなく参照として保存する場合:

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

`--secret-input-mode ref` を使用すると、オンボーディングはプレーンテキストのキー値ではなく環境変数ベースの参照を書き込みます。
認証プロファイルベースのプロバイダーの場合は `keyRef` エントリを書き込みます。カスタムプロバイダーの場合は `models.providers.<id>.apiKey` を環境変数参照として書き込みます（例: `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`）。

非インタラクティブ `ref` モードの規約:

- オンボーディングプロセスの環境にプロバイダーの環境変数を設定してください（例: `OPENAI_API_KEY`）。
- その環境変数も設定されていない限り、インラインキーフラグ（例: `--openai-api-key`）を渡さないでください。
- 必要な環境変数なしにインラインキーフラグが渡された場合、オンボーディングはガイダンスと共に即座に失敗します。

インタラクティブオンボーディングでの参照モードの動作:

- プロンプトが表示されたら **Use secret reference** を選択してください。
- 次に以下のいずれかを選択してください:
  - 環境変数
  - 設定済みのシークレットプロバイダー（`file` または `exec`）
- オンボーディングは参照を保存する前に高速な事前検証を実行します。
  - 検証に失敗した場合、オンボーディングはエラーを表示し、リトライできます。

非インタラクティブ Z.AI エンドポイントの選択:

注意: `--auth-choice zai-api-key` は、キーに最適な Z.AI エンドポイントを自動検出するようになりました（`zai/glm-5` を使用する汎用 API を優先します）。
GLM Coding Plan のエンドポイントを特定したい場合は、`zai-coding-global` または `zai-coding-cn` を選択してください。

```bash
# プロンプトなしのエンドポイント選択
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# その他の Z.AI エンドポイント選択:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

非インタラクティブ Mistral の例:

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

フローに関する注意事項:

- `quickstart`: 最小限のプロンプトで、Gateway トークンを自動生成します。
- `manual`: ポート/バインド/認証の完全なプロンプトです（`advanced` のエイリアス）。
- ローカルオンボーディングの DM スコープの動作: [CLI オンボーディングリファレンス](/start/wizard-cli-reference#outputs-and-internals)。
- 最速のファーストチャット: `openclaw dashboard`（Control UI、チャンネルセットアップ不要）。
- カスタムプロバイダー: リストにないホストプロバイダーを含め、任意の OpenAI または Anthropic 互換エンドポイントに接続できます。Unknown を使用すると自動検出します。

## よく使うフォローアップコマンド

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` は非インタラクティブモードを意味しません。スクリプトでは `--non-interactive` を使用してください。
</Note>
