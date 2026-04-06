---
read_when:
    - 認証プロファイルのローテーション、クールダウン、モデルフォールバック動作の診断
    - 認証プロファイルまたはモデルのフェイルオーバールールの更新
summary: OpenClawが認証プロファイルをローテーションし、モデル間でフォールバックする仕組み
title: モデルフェイルオーバー
x-i18n:
    generated_at: "2026-04-02T07:38:07Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 35142ba0e5fab2e7bece8b50b86b5ae93394a6e4965da8efb0140dedc9b43e76
    source_path: concepts/model-failover.md
    workflow: 15
---

# モデルフェイルオーバー

OpenClawは障害を2段階で処理します:

1. 現在のプロバイダー内での**認証プロファイルローテーション**。
2. `agents.defaults.model.fallbacks` の次のモデルへの**モデルフォールバック**。

このドキュメントでは、ランタイムのルールとそれを支えるデータについて説明します。

## 認証ストレージ（キー + OAuth）

OpenClawはAPIキーとOAuthトークンの両方に**認証プロファイル**を使用します。

- シークレットは `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` に保存されます（レガシー: `~/.openclaw/agent/auth-profiles.json`）。
- 設定の `auth.profiles` / `auth.order` は**メタデータ + ルーティングのみ**です（シークレットは含みません）。
- レガシーのインポート専用OAuthファイル: `~/.openclaw/credentials/oauth.json`（初回使用時に `auth-profiles.json` にインポートされます）。

詳細: [/concepts/oauth](/concepts/oauth)

認証情報の種類:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（一部のプロバイダーでは `projectId`/`enterpriseUrl` も含む）

## プロファイルID

OAuthログインは、複数のアカウントが共存できるよう個別のプロファイルを作成します。

- デフォルト: メールアドレスが利用できない場合は `provider:default`。
- メール付きOAuth: `provider:<email>`（例: `google-antigravity:user@gmail.com`）。

プロファイルは `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` の `profiles` 配下に保存されます。

## ローテーション順序

プロバイダーに複数のプロファイルがある場合、OpenClawは以下の順序で選択します:

1. **明示的な設定**: `auth.order[provider]`（設定されている場合）。
2. **設定済みプロファイル**: プロバイダーでフィルタリングされた `auth.profiles`。
3. **保存済みプロファイル**: プロバイダーの `auth-profiles.json` 内のエントリ。

明示的な順序が設定されていない場合、OpenClawはラウンドロビン順序を使用します:

- **プライマリキー:** プロファイルタイプ（**OAuthがAPIキーより優先**）。
- **セカンダリキー:** `usageStats.lastUsed`（各タイプ内で最も古いものが優先）。
- **クールダウン/無効化されたプロファイル**は末尾に移動され、期限切れが最も近いものから順に並びます。

### セッションスティッキネス（キャッシュフレンドリー）

OpenClawはプロバイダーキャッシュを温かく保つために、**選択された認証プロファイルをセッションごとに固定**します。
リクエストごとにローテーションすることは**ありません**。固定されたプロファイルは以下の場合まで再利用されます:

- セッションがリセットされた場合（`/new` / `/reset`）
- コンパクションが完了した場合（コンパクションカウントが増加）
- プロファイルがクールダウン/無効化状態の場合

`/model …@<profileId>` による手動選択は、そのセッションの**ユーザーオーバーライド**を設定し、
新しいセッションが開始されるまで自動ローテーションされません。

自動固定されたプロファイル（セッションルーターによって選択）は**優先設定**として扱われます:
最初に試行されますが、レート制限/タイムアウト時にOpenClawは別のプロファイルにローテーションする場合があります。
ユーザー固定のプロファイルはそのプロファイルにロックされたままです。失敗してモデルフォールバックが
設定されている場合、OpenClawはプロファイルを切り替える代わりに次のモデルに移行します。

### OAuthが「見失われた」ように見える理由

同じプロバイダーに対してOAuthプロファイルとAPIキープロファイルの両方がある場合、固定されていない限り、ラウンドロビンによりメッセージ間で切り替わることがあります。単一のプロファイルを強制するには:

- `auth.order[provider] = ["provider:profileId"]` で固定する、または
- `/model …` でプロファイルオーバーライド付きのセッションごとのオーバーライドを使用する（UI/チャットサーフェスでサポートされている場合）。

## クールダウン

認証/レート制限エラー（またはレート制限に見えるタイムアウト）でプロファイルが失敗した場合、
OpenClawはクールダウンとしてマークし、次のプロファイルに移行します。
フォーマット/無効リクエストエラー（例: Cloud Code Assistのツール呼び出しID
検証失敗）はフェイルオーバー対象として扱われ、同じクールダウンが適用されます。
`Unhandled stop reason: error`、`stop reason: error`、`reason: error` などの
OpenAI互換のstop-reasonエラーは、タイムアウト/フェイルオーバーシグナルとして分類されます。

クールダウンは指数バックオフを使用します:

- 1分
- 5分
- 25分
- 1時間（上限）

状態は `auth-profiles.json` の `usageStats` 配下に保存されます:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## 課金による無効化

課金/クレジット障害（例:「insufficient credits」/「credit balance too low」）はフェイルオーバー対象として扱われますが、通常は一時的ではありません。短いクールダウンの代わりに、OpenClawはプロファイルを**無効化**（より長いバックオフ付き）としてマークし、次のプロファイル/プロバイダーにローテーションします。

状態は `auth-profiles.json` に保存されます:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

デフォルト:

- 課金バックオフは**5時間**から開始し、課金障害ごとに倍増し、**24時間**で上限に達します。
- プロファイルが**24時間**（設定可能）障害なしの場合、バックオフカウンターがリセットされます。
- 過負荷リトライでは、モデルフォールバック前に**1回の同一プロバイダープロファイルローテーション**が許可されます。
- 過負荷リトライはデフォルトで**0ミリ秒のバックオフ**を使用します。

## モデルフォールバック

プロバイダーのすべてのプロファイルが失敗した場合、OpenClawは
`agents.defaults.model.fallbacks` の次のモデルに移行します。これは認証障害、レート制限、
プロファイルローテーションを使い果たしたタイムアウトに適用されます（その他のエラーはフォールバックを進めません）。

過負荷およびレート制限エラーは、課金クールダウンよりも積極的に処理されます。
デフォルトでは、OpenClawは1回の同一プロバイダー認証プロファイルリトライを許可し、
その後待機せずに次の設定済みモデルフォールバックに切り替えます。これは
`auth.cooldowns.overloadedProfileRotations`、
`auth.cooldowns.overloadedBackoffMs`、
`auth.cooldowns.rateLimitedProfileRotations` で調整できます。

モデルオーバーライド（フックまたは CLI）で実行が開始された場合でも、設定済みのフォールバックを試行した後、
フォールバックは `agents.defaults.model.primary` で終了します。

## 関連設定

以下については [Gateway ゲートウェイ設定](/gateway/configuration)を参照してください:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `auth.cooldowns.overloadedProfileRotations` / `auth.cooldowns.overloadedBackoffMs`
- `auth.cooldowns.rateLimitedProfileRotations`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` ルーティング

モデル選択とフォールバックの全体的な概要については[モデル](/concepts/models)を参照してください。
