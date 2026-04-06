---
read_when:
    - Gateway ゲートウェイ、ワークスペース、認証、チャネル、Skillsのガイド付きセットアップが必要
summary: '`openclaw onboard`（対話型オンボーディング）のCLIリファレンス'
title: onboard
x-i18n:
    generated_at: "2026-04-02T07:35:00Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f43fcc868709afb466229218e74aa5dc9b19bd7e5342582620e94121d8c71a30
    source_path: cli/onboard.md
    workflow: 15
---

# `openclaw onboard`

ローカルまたはリモートのGateway ゲートウェイセットアップのための対話型オンボーディングです。

## 関連ガイド

- CLIオンボーディングハブ: [オンボーディング（CLI）](/start/wizard)
- オンボーディング概要: [オンボーディング概要](/start/onboarding-overview)
- CLIオンボーディングリファレンス: [CLI セットアップ リファレンス](/start/wizard-cli-reference)
- CLI自動化: [CLI自動化](/start/wizard-cli-automation)
- macOSオンボーディング: [オンボーディング（macOSアプリ）](/start/onboarding)

## 例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

プレーンテキストのプライベートネットワーク`ws://`ターゲット（信頼されたネットワークのみ）には、オンボーディングプロセス環境で`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`を設定してください。

非対話型カスタムプロバイダー:

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --secret-input-mode plaintext \
  --custom-compatibility openai
```

`--custom-api-key`は非対話モードではオプションです。省略した場合、オンボーディングは`CUSTOM_API_KEY`を確認します。

非対話型Ollama:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

`--custom-base-url`のデフォルトは`http://127.0.0.1:11434`です。`--custom-model-id`はオプションです。省略した場合、オンボーディングはOllamaの推奨デフォルトを使用します。`kimi-k2.5:cloud`などのクラウドモデルIDもここで使用できます。

プロバイダーキーをプレーンテキストではなく参照として保存:

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

`--secret-input-mode ref`を指定すると、オンボーディングはプレーンテキストのキー値ではなく環境変数ベースの参照を書き込みます。
認証プロファイルベースのプロバイダーの場合は`keyRef`エントリが書き込まれ、カスタムプロバイダーの場合は`models.providers.<id>.apiKey`が環境変数参照として書き込まれます（例: `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`）。

非対話型`ref`モードの規約:

- オンボーディングプロセス環境でプロバイダーの環境変数を設定してください（例: `OPENAI_API_KEY`）。
- その環境変数も設定されていない限り、インラインキーフラグ（例: `--openai-api-key`）を渡さないでください。
- 必要な環境変数なしでインラインキーフラグが渡された場合、オンボーディングはガイダンスとともに即座に失敗します。

非対話モードでのGateway ゲートウェイトークンオプション:

- `--gateway-auth token --gateway-token <token>`はプレーンテキストトークンを保存します。
- `--gateway-auth token --gateway-token-ref-env <name>`は`gateway.auth.token`を環境変数SecretRefとして保存します。
- `--gateway-token`と`--gateway-token-ref-env`は相互排他です。
- `--gateway-token-ref-env`にはオンボーディングプロセス環境で空でない環境変数が必要です。
- `--install-daemon`使用時、トークン認証がトークンを必要とする場合、SecretRef管理のGateway ゲートウェイトークンは検証されますが、解決済みプレーンテキストとしてスーパーバイザーサービスの環境メタデータに永続化されません。
- `--install-daemon`使用時、トークンモードがトークンを必要とし、設定されたトークンSecretRefが未解決の場合、オンボーディングは修復ガイダンスとともに閉じた状態で失敗します。
- `--install-daemon`使用時、`gateway.auth.token`と`gateway.auth.password`の両方が設定されており`gateway.auth.mode`が未設定の場合、オンボーディングはモードが明示的に設定されるまでインストールをブロックします。

例:

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --accept-risk
```

非対話型ローカルGateway ゲートウェイヘルスチェック:

- `--skip-health`を渡さない限り、オンボーディングは正常終了前にローカルGateway ゲートウェイが到達可能になるまで待機します。
- `--install-daemon`はマネージドGateway ゲートウェイインストールパスを最初に開始します。これがない場合は、`openclaw gateway run`などでローカルGateway ゲートウェイが既に実行されている必要があります。
- 自動化で設定/ワークスペース/ブートストラップの書き込みのみが必要な場合は、`--skip-health`を使用してください。
- ネイティブWindowsでは、`--install-daemon`はまずスケジュールタスクを試み、タスク作成が拒否された場合はユーザーごとのスタートアップフォルダーログインアイテムにフォールバックします。

参照モードでの対話型オンボーディングの動作:

- プロンプトが表示されたら**シークレット参照を使用**を選択します。
- 次にいずれかを選択します:
  - 環境変数
  - 設定済みシークレットプロバイダー（`file`または`exec`）
- オンボーディングは参照を保存する前に高速なプリフライト検証を実行します。
  - 検証が失敗した場合、オンボーディングはエラーを表示しリトライできます。

非対話型Z.AIエンドポイントの選択:

注意: `--auth-choice zai-api-key`はキーに最適なZ.AIエンドポイントを自動検出するようになりました（`zai/glm-5`の一般APIが優先されます）。
GLM Coding Planのエンドポイントを特に使用したい場合は、`zai-coding-global`または`zai-coding-cn`を選択してください。

```bash
# プロンプトなしのエンドポイント選択
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# その他のZ.AIエンドポイント選択:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

非対話型Mistralの例:

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

フローに関する注意:

- `quickstart`: 最小限のプロンプトで、Gateway ゲートウェイトークンを自動生成します。
- `manual`: ポート/バインド/認証の完全なプロンプト（`advanced`のエイリアス）。
- Web検索ステップで**Grok**を選択すると、同じ`XAI_API_KEY`で`x_search`を有効にし、オプションで`x_search`モデルを選択するための別のフォローアッププロンプトがトリガーされる場合があります。他のWeb検索プロバイダーではそのプロンプトは表示されません。
- ローカルオンボーディングのダイレクトメッセージスコープの動作: [CLI セットアップ リファレンス](/start/wizard-cli-reference#outputs-and-internals)。
- 最速の初回チャット: `openclaw dashboard`（コントロールUI、チャネルセットアップ不要）。
- カスタムプロバイダー: 一覧に掲載されていないホストされたプロバイダーを含む、任意のOpenAIまたはAnthropic互換エンドポイントに接続できます。自動検出にはUnknownを使用してください。

## よく使うフォローアップコマンド

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`は非対話モードを意味しません。スクリプトには`--non-interactive`を使用してください。
</Note>
