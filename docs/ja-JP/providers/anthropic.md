---
summary: "APIキーまたはsetup-tokenを使ってOpenClawでAnthropic Claudeを利用する"
read_when:
  - OpenClawでAnthropicのモデルを使いたい場合
  - APIキーの代わりにsetup-tokenを使いたい場合
title: "Anthropic"
---

# Anthropic (Claude)

AnthropicはClaudeモデルファミリーを開発しており、APIを通じてアクセスを提供しています。
OpenClawでは、APIキーまたは**setup-token**で認証できます。

## オプションA: Anthropic APIキー

**適した用途:** 標準的なAPIアクセスと従量課金制。
APIキーはAnthropicコンソールで作成してください。

### CLIセットアップ

```bash
openclaw onboard
# 選択: Anthropic API key

# または非インタラクティブ
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 設定スニペット

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## プロンプトキャッシング（Anthropic API）

OpenClawはAnthropicのプロンプトキャッシング機能をサポートしています。これは**APIのみ**の機能であり、サブスクリプション認証ではキャッシュ設定は有効になりません。

### 設定

モデル設定の `cacheRetention` パラメーターを使用します。

| 値       | キャッシュ期間 | 説明                                 |
| ------- | -------------- | ------------------------------------ |
| `none`  | キャッシュなし | プロンプトキャッシングを無効にする   |
| `short` | 5分            | APIキー認証のデフォルト              |
| `long`  | 1時間          | 拡張キャッシュ（ベータフラグが必要） |

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

### デフォルト値

Anthropic APIキー認証を使用している場合、OpenClawはすべてのAnthropicモデルに対して `cacheRetention: "short"`（5分キャッシュ）を自動的に適用します。設定で `cacheRetention` を明示的に指定することで上書きできます。

### エージェントごとのcacheRetentionオーバーライド

モデルレベルのparamsをベースラインとして使用し、`agents.list[].params` を通じて特定のエージェントのみオーバーライドします。

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
      { id: "alerts", params: { cacheRetention: "none" } }, // このエージェントのみオーバーライド
    ],
  },
}
```

キャッシュ関連paramsのマージ順序:

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（`id` が一致するもの、キーで上書き）

これにより、あるエージェントは長期キャッシュを保持しつつ、同じモデルを使う別のエージェントはバースト性の高いトラフィックや再利用率の低いトラフィックに対する書き込みコストを避けるためにキャッシングを無効にできます。

### Bedrock Claude に関する注意事項

- Bedrock上のAnthropicClaudeモデル（`amazon-bedrock/*anthropic.claude*`）は、設定されている場合に `cacheRetention` のパススルーを受け入れます。
- Bedrock上の非Anthropicモデルは、実行時に強制的に `cacheRetention: "none"` になります。
- Anthropic APIキーのスマートデフォルトは、明示的な値が設定されていない場合にBedrock上のClaudeモデル参照に対しても `cacheRetention: "short"` を設定します。

### レガシーパラメーター

旧来の `cacheControlTtl` パラメーターは後方互換性のために引き続きサポートされています:

- `"5m"` は `short` にマップされます
- `"1h"` は `long` にマップされます

新しい `cacheRetention` パラメーターへの移行を推奨します。

OpenClawはAnthropicのAPIリクエストに `extended-cache-ttl-2025-04-11` ベータフラグを含めています。プロバイダーヘッダーをオーバーライドする場合は維持してください（[/gateway/configuration](/gateway/configuration) を参照）。

## 1Mコンテキストウィンドウ（Anthropicベータ）

Anthropicの1Mコンテキストウィンドウはベータゲートされています。OpenClawでは、サポートされているOpus/Sonnetモデルに対して `params.context1m: true` を設定することでモデルごとに有効にできます。

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

OpenClawはこれをAnthropicリクエストで `anthropic-beta: context-1m-2025-08-07` にマップします。

注意: AnthropicはOAuth/サブスクリプショントークン（`sk-ant-oat-*`）を使用する場合に `context-1m-*` ベータリクエストを拒否します。OpenClawはOAuth認証の場合に自動的にcontext1mベータヘッダーをスキップし、必要なOAuthベータを維持します。

## オプションB: Claude setup-token

**適した用途:** Claudeサブスクリプションの利用。

### setup-tokenの取得方法

setup-tokenはAnthropicコンソールではなく、**Claude Code CLI**によって作成されます。これは**任意のマシン**で実行できます:

```bash
claude setup-token
```

トークンをOpenClawに貼り付けてください（ウィザード: **Anthropic token (paste setup-token)**）、またはGatewayホスト上で実行してください:

```bash
openclaw models auth setup-token --provider anthropic
```

異なるマシンでトークンを生成した場合は、貼り付けてください:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLIセットアップ（setup-token）

```bash
# オンボーディング中にsetup-tokenを貼り付ける
openclaw onboard --auth-choice setup-token
```

### 設定スニペット（setup-token）

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 注意事項

- `claude setup-token` でsetup-tokenを生成して貼り付けるか、Gatewayホスト上で `openclaw models auth setup-token` を実行してください。
- Claudeサブスクリプションで「OAuth token refresh failed …」というエラーが表示された場合は、setup-tokenで再認証してください。[/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription) を参照してください。
- 認証の詳細と再利用ルールは [/concepts/oauth](/concepts/oauth) に記載されています。

## トラブルシューティング

**401エラー / トークンが突然無効になった**

- Claudeサブスクリプション認証は期限切れまたは取り消されることがあります。`claude setup-token` を再実行して**Gatewayホスト**に貼り付けてください。
- Claude CLIのログインが別のマシンにある場合は、Gatewayホスト上で `openclaw models auth paste-token --provider anthropic` を使用してください。

**No API key found for provider "anthropic"**

- 認証は**エージェントごと**です。新しいエージェントはメインエージェントのキーを継承しません。
- そのエージェントのオンボーディングを再実行するか、Gatewayホスト上でsetup-token / APIキーを貼り付けてから `openclaw models status` で確認してください。

**No credentials found for profile `anthropic:default`**

- `openclaw models status` を実行してどの認証プロファイルがアクティブか確認してください。
- オンボーディングを再実行するか、そのプロファイルのsetup-token / APIキーを貼り付けてください。

**No available auth profile (all in cooldown/unavailable)**

- `openclaw models status --json` で `auth.unusableProfiles` を確認してください。
- 別のAnthropicプロファイルを追加するか、クールダウンが終わるまで待ってください。

詳細: [/gateway/troubleshooting](/gateway/troubleshooting) および [/help/faq](/help/faq)
