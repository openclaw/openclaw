---
read_when:
    - OpenClawでAnthropicモデルを使用したい場合
    - APIキーの代わりにsetup-tokenを使用したい場合
    - Gateway ゲートウェイホストでClaude CLIサブスクリプション認証を再利用したい場合
summary: OpenClawでAPI キー、setup-token、またはClaude CLIを使用してAnthropic Claudeを利用する
title: Anthropic
x-i18n:
    generated_at: "2026-04-02T08:58:20Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6bc7a6a1b49434c201802578bbff4431aa3ebe8996db878ffba906fad8932279
    source_path: providers/anthropic.md
    workflow: 15
---

# Anthropic (Claude)

Anthropicは**Claude**モデルファミリーを開発し、APIを通じてアクセスを提供しています。
OpenClawでは、APIキーまたは**setup-token**で認証できます。

## オプションA: Anthropic APIキー

**最適な用途:** 標準的なAPIアクセスと従量課金。
Anthropic ConsoleでAPIキーを作成してください。

### CLIセットアップ

```bash
openclaw onboard
# 選択: Anthropic API key

# または非対話式
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Claude CLI設定スニペット

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Thinkingのデフォルト設定 (Claude 4.6)

- Anthropic Claude 4.6モデルは、明示的なthinkingレベルが設定されていない場合、OpenClawでデフォルトで`adaptive` thinkingになります。
- メッセージごとに上書きできます（`/think:<level>`）。またはモデルパラメータで設定:
  `agents.defaults.models["anthropic/<model>"].params.thinking`
- 関連するAnthropicドキュメント:
  - [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
  - [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

## Fastモード (Anthropic API)

OpenClawの共通`/fast`トグルは、`api.anthropic.com`に送信されるAPIキーおよびOAuth認証リクエストを含む、直接のパブリックAnthropicトラフィックもサポートしています。

- `/fast on`は`service_tier: "auto"`にマッピングされます
- `/fast off`は`service_tier: "standard_only"`にマッピングされます
- 設定のデフォルト:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-6": {
          params: { fastMode: true },
        },
      },
    },
  },
}
```

重要な制限事項:

- OpenClawがAnthropicサービスティアを注入するのは、直接の`api.anthropic.com`リクエストのみです。`anthropic/*`をプロキシやGateway ゲートウェイ経由でルーティングする場合、`/fast`は`service_tier`を変更しません。
- 明示的なAnthropicの`serviceTier`または`service_tier`モデルパラメータは、両方が設定されている場合`/fast`のデフォルトを上書きします。
- Anthropicはレスポンスの`usage.service_tier`で有効なティアを報告します。Priority Tierの容量がないアカウントでは、`service_tier: "auto"`が`standard`に解決される場合があります。

## プロンプトキャッシュ (Anthropic API)

OpenClawはAnthropicのプロンプトキャッシュ機能をサポートしています。これは**APIのみ**であり、サブスクリプション認証ではキャッシュ設定は反映されません。

### 設定

モデル設定で`cacheRetention`パラメータを使用します:

| 値      | キャッシュ期間 | 説明                                       |
| ------- | -------------- | ------------------------------------------ |
| `none`  | キャッシュなし | プロンプトキャッシュを無効化               |
| `short` | 5分            | APIキー認証のデフォルト                    |
| `long`  | 1時間          | 拡張キャッシュ（ベータフラグが必要）       |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### デフォルト

Anthropic APIキー認証を使用する場合、OpenClawはすべてのAnthropicモデルに自動的に`cacheRetention: "short"`（5分間キャッシュ）を適用します。設定で明示的に`cacheRetention`を指定することで上書きできます。

### エージェントごとのcacheRetention上書き

モデルレベルのパラメータをベースラインとして使用し、`agents.list[].params`で特定のエージェントを上書きします。

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" }, // ほとんどのエージェントのベースライン
        },
      },
    },
    list: [
      { id: "research", default: true },
      { id: "alerts", params: { cacheRetention: "none" } }, // このエージェントのみの上書き
    ],
  },
}
```

キャッシュ関連パラメータの設定マージ順序:

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（一致する`id`に対して、キーごとに上書き）

これにより、あるエージェントは長期キャッシュを維持しながら、同じモデル上の別のエージェントではバースト性の高い/再利用率の低いトラフィックでの書き込みコストを避けるためにキャッシュを無効化できます。

### Bedrock Claudeに関する注意

- Bedrock上のAnthropic Claudeモデル（`amazon-bedrock/*anthropic.claude*`）は、設定時に`cacheRetention`パススルーを受け入れます。
- Anthropic以外のBedrockモデルは、ランタイム時に`cacheRetention: "none"`が強制されます。
- Anthropic APIキーのスマートデフォルトは、明示的な値が設定されていない場合、Claude-on-Bedrockモデル参照にも`cacheRetention: "short"`をシードします。

### レガシーパラメータ

古い`cacheControlTtl`パラメータは後方互換性のために引き続きサポートされています:

- `"5m"`は`short`にマッピングされます
- `"1h"`は`long`にマッピングされます

新しい`cacheRetention`パラメータへの移行を推奨します。

OpenClawはAnthropic APIリクエストに`extended-cache-ttl-2025-04-11`ベータフラグを含めます。プロバイダーヘッダーを上書きする場合はこのフラグを維持してください（[/gateway/configuration](/gateway/configuration)を参照）。

## 1Mコンテキストウィンドウ (Anthropicベータ)

Anthropicの1Mコンテキストウィンドウはベータゲートされています。OpenClawでは、サポートされているOpus/Sonnetモデルに対して`params.context1m: true`でモデルごとに有効化します。

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { context1m: true },
        },
      },
    },
  },
}
```

OpenClawはこれをAnthropicリクエストの`anthropic-beta: context-1m-2025-08-07`にマッピングします。

これは、そのモデルに対して`params.context1m`が明示的に`true`に設定されている場合にのみ有効になります。

要件: Anthropicがその認証情報で長文コンテキストの使用を許可している必要があります（通常はAPIキー課金、またはExtra Usageが有効なサブスクリプションアカウント）。それ以外の場合、Anthropicは以下を返します:
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`

注意: Anthropicは現在、サブスクリプションsetup-token（`sk-ant-oat-*`）を使用した`context-1m-*`ベータリクエストを拒否します。サブスクリプション認証で`context1m: true`を設定した場合、OpenClawは警告をログに記録し、必要なOAuthベータを維持しながらcontext1mベータヘッダーをスキップして標準コンテキストウィンドウにフォールバックします。

## オプションB: Claude CLIをメッセージプロバイダーとして使用

**最適な用途:** Claude CLIがすでにインストールされ、Claudeサブスクリプションでサインインしている単一ユーザーのGateway ゲートウェイホスト。

このパスは、Anthropic APIを直接呼び出す代わりに、ローカルの`claude`バイナリをモデル推論に使用します。OpenClawはこれを以下のようなモデル参照を持つ**CLIバックエンドプロバイダー**として扱います:

- `claude-cli/claude-sonnet-4-6`
- `claude-cli/claude-opus-4-6`

動作の仕組み:

1. OpenClawが**Gateway ゲートウェイホスト**上で`claude -p --output-format json ...`を起動します。
2. 最初のターンで`--session-id <uuid>`を送信します。
3. 後続のターンでは`--resume <sessionId>`を通じて保存されたClaudeセッションを再利用します。
4. チャットメッセージは通常のOpenClawメッセージパイプラインを通りますが、実際のモデル応答はClaude CLIによって生成されます。

### 要件

- Gateway ゲートウェイホストにClaude CLIがインストールされ、PATHで利用可能であること。または絶対コマンドパスが設定されていること。
- Claude CLIが同じホストですでに認証されていること:

```bash
claude auth status
```

- 設定で明示的に`claude-cli/...`または`claude-cli`バックエンド設定を参照している場合、OpenClawはGateway ゲートウェイ起動時にバンドルされたAnthropicプラグインを自動ロードします。

### 設定スニペット

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "claude-cli/claude-sonnet-4-6",
      },
      models: {
        "claude-cli/claude-sonnet-4-6": {},
      },
      sandbox: { mode: "off" },
    },
  },
}
```

`claude`バイナリがGateway ゲートウェイホストのPATHにない場合:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

### 得られるもの

- ローカルCLIからのClaudeサブスクリプション認証の再利用
- 通常のOpenClawメッセージ/セッションルーティング
- ターン間でのClaude CLIセッションの継続性

### Anthropic認証からClaude CLIへの移行

現在`anthropic/...`をsetup-tokenまたはAPIキーで使用していて、同じGateway ゲートウェイホストをClaude CLIに切り替えたい場合:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
```

またはオンボーディングで:

```bash
openclaw onboard --auth-choice anthropic-cli
```

これにより以下が実行されます:

- Gateway ゲートウェイホストでClaude CLIがすでにサインインしていることを確認
- デフォルトモデルを`claude-cli/...`に切り替え
- `anthropic/claude-opus-4-6`のようなAnthropicデフォルトモデルのフォールバックを`claude-cli/claude-opus-4-6`に書き換え
- `agents.defaults.models`に対応する`claude-cli/...`エントリを追加

以下は実行**されません**:

- 既存のAnthropic認証プロファイルの削除
- メインのデフォルトモデル/許可リストパス以外のすべての古い`anthropic/...`設定参照の削除

そのためロールバックは簡単です: 必要に応じてデフォルトモデルを`anthropic/...`に戻すだけです。

### 重要な制限事項

- これはAnthropic APIプロバイダーでは**ありません**。ローカルCLIランタイムです。
- CLIバックエンド実行時はOpenClaw側でツールが無効になります。
- テキスト入力、テキスト出力のみ。OpenClawのストリーミングハンドオフはありません。
- 個人用Gateway ゲートウェイホストに最適であり、共有マルチユーザー課金環境には向きません。

詳細: [/gateway/cli-backends](/gateway/cli-backends)

## オプションC: Claude setup-token

**最適な用途:** Claudeサブスクリプションの利用。

### setup-tokenの取得方法

setup-tokenはAnthropic Consoleではなく、**Claude Code CLI**で作成されます。これは**任意のマシン**で実行できます:

```bash
claude setup-token
```

トークンをOpenClawに貼り付けます（ウィザード: **Anthropic token (paste setup-token)**）。またはGateway ゲートウェイホストで実行します:

```bash
openclaw models auth setup-token --provider anthropic
```

別のマシンでトークンを生成した場合は、貼り付けます:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLIセットアップ (setup-token)

```bash
# セットアップ中にsetup-tokenを貼り付け
openclaw onboard --auth-choice setup-token
```

### 設定スニペット (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 注意事項

- `claude setup-token`でsetup-tokenを生成して貼り付けるか、Gateway ゲートウェイホストで`openclaw models auth setup-token`を実行してください。
- Claudeサブスクリプションで「OAuth token refresh failed …」と表示された場合は、setup-tokenで再認証してください。[/gateway/troubleshooting](/gateway/troubleshooting)を参照してください。
- 認証の詳細と再利用ルールは[/concepts/oauth](/concepts/oauth)にあります。

## トラブルシューティング

**401エラー / トークンが突然無効になった**

- Claudeサブスクリプション認証は期限切れまたは失効する場合があります。`claude setup-token`を再実行し、**Gateway ゲートウェイホスト**に貼り付けてください。
- Claude CLIログインが別のマシンにある場合は、Gateway ゲートウェイホストで`openclaw models auth paste-token --provider anthropic`を使用してください。

**No API key found for provider "anthropic"**

- 認証は**エージェントごと**です。新しいエージェントはメインエージェントのキーを継承しません。
- そのエージェントのオンボーディングを再実行するか、Gateway ゲートウェイホストでsetup-token / APIキーを貼り付け、`openclaw models status`で確認してください。

**No credentials found for profile `anthropic:default`**

- `openclaw models status`を実行して、アクティブな認証プロファイルを確認してください。
- オンボーディングを再実行するか、そのプロファイルのsetup-token / APIキーを貼り付けてください。

**No available auth profile (all in cooldown/unavailable)**

- `openclaw models status --json`で`auth.unusableProfiles`を確認してください。
- 別のAnthropicプロファイルを追加するか、クールダウンが終了するまで待ってください。

詳細: [/gateway/troubleshooting](/gateway/troubleshooting)および[/help/faq](/help/faq)。
