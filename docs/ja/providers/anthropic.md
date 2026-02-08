---
summary: "OpenClaw で API キーまたは setup-token を使用して Anthropic Claude を利用します"
read_when:
  - OpenClaw で Anthropic モデルを使用したい場合
  - API キーの代わりに setup-token を使用したい場合
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:51Z
---

# Anthropic（Claude）

Anthropic は **Claude** モデルファミリーを開発しており、API を通じてアクセスを提供しています。
OpenClaw では、API キーまたは **setup-token** を使用して認証できます。

## オプション A: Anthropic API キー

**最適な用途:** 標準的な API アクセスおよび使用量ベースの課金。
Anthropic Console で API キーを作成してください。

### CLI セットアップ

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 設定スニペット

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## プロンプトキャッシュ（Anthropic API）

OpenClaw は Anthropic のプロンプトキャッシュ機能をサポートしています。これは **API 専用** です。サブスクリプション認証ではキャッシュ設定は反映されません。

### 設定

モデル設定で `cacheRetention` パラメーターを使用してください。

| 値      | キャッシュ期間 | 説明                                 |
| ------- | -------------- | ------------------------------------ |
| `none`  | キャッシュなし | プロンプトキャッシュを無効化         |
| `short` | 5 分           | API キー認証のデフォルト             |
| `long`  | 1 時間         | 拡張キャッシュ（ベータフラグが必要） |

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

Anthropic API キー認証を使用する場合、OpenClaw はすべての Anthropic モデルに対して自動的に `cacheRetention: "short"`（5 分キャッシュ）を適用します。設定で明示的に `cacheRetention` を指定することで、これを上書きできます。

### レガシーパラメーター

古い `cacheControlTtl` パラメーターは、後方互換性のために引き続きサポートされています。

- `"5m"` は `short` にマップされます
- `"1h"` は `long` にマップされます

新しい `cacheRetention` パラメーターへの移行を推奨します。

OpenClaw には Anthropic API リクエスト用の `extended-cache-ttl-2025-04-11` ベータフラグが含まれています。プロバイダーヘッダーを上書きする場合は、これを保持してください（[/gateway/configuration](/gateway/configuration) を参照）。

## オプション B: Claude setup-token

**最適な用途:** Claude サブスクリプションを使用する場合。

### setup-token の取得方法

setup-token は Anthropic Console ではなく、**Claude Code CLI** によって作成されます。**任意のマシン** で実行できます。

```bash
claude setup-token
```

トークンを OpenClaw に貼り付ける（ウィザード: **Anthropic token（setup-token を貼り付け）**）か、ゲートウェイ ホストで実行してください。

```bash
openclaw models auth setup-token --provider anthropic
```

別のマシンでトークンを生成した場合は、貼り付けてください。

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI セットアップ（setup-token）

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### 設定スニペット（setup-token）

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 注記

- `claude setup-token` で setup-token を生成して貼り付けるか、ゲートウェイ ホストで `openclaw models auth setup-token` を実行してください。
- Claude サブスクリプションで「OAuth token refresh failed …」と表示される場合は、setup-token で再認証してください。詳細は [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription) を参照してください。
- 認証の詳細および再利用ルールは [/concepts/oauth](/concepts/oauth) に記載されています。

## トラブルシューティング

**401 エラー / トークンが突然無効になる**

- Claude サブスクリプション認証は期限切れや失効が発生することがあります。`claude setup-token` を再実行し、**ゲートウェイ ホスト** に貼り付けてください。
- Claude CLI のログインが別のマシンにある場合は、ゲートウェイ ホストで
  `openclaw models auth paste-token --provider anthropic` を使用してください。

**プロバイダー "anthropic" の API キーが見つかりません**

- 認証は **エージェントごと** です。新しいエージェントはメインエージェントのキーを継承しません。
- そのエージェントのオンボーディングを再実行するか、setup-token または API キーを
  ゲートウェイ ホストに貼り付け、`openclaw models status` で確認してください。

**プロファイル `anthropic:default` の資格情報が見つかりません**

- `openclaw models status` を実行して、どの認証プロファイルが有効かを確認してください。
- オンボーディングを再実行するか、そのプロファイル用の setup-token または API キーを貼り付けてください。

**利用可能な認証プロファイルがありません（すべてクールダウン中 / 利用不可）**

- `openclaw models status --json` で `auth.unusableProfiles` を確認してください。
- 別の Anthropic プロファイルを追加するか、クールダウンが終了するまで待ってください。

詳細: [/gateway/troubleshooting](/gateway/troubleshooting) および [/help/faq](/help/faq)。
