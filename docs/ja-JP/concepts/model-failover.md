---
summary: "OpenClaw が認証プロフィールをローテーションし、モデル間でフォールバックする方法"
read_when:
  - 認証プロフィールのローテーション、クールダウン、またはモデルフォールバックの動作を診断しているとき
  - 認証プロフィールまたはモデルのフェイルオーバールールを更新しているとき
title: "モデルフェイルオーバー"
---

# モデルフェイルオーバー

OpenClaw は 2 段階で障害を処理します。

1. 現在のプロバイダー内での**認証プロフィールのローテーション**。
2. `agents.defaults.model.fallbacks` 内の次のモデルへの**モデルフォールバック**。

このドキュメントでは、ランタイムのルールとその背後にあるデータを説明します。

## 認証ストレージ（キーと OAuth）

OpenClaw は API キーと OAuth トークンの両方に**認証プロフィール**を使用します。

- シークレットは `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（レガシー: `~/.openclaw/agent/auth-profiles.json`）に保存されます。
- 設定の `auth.profiles` / `auth.order` は**メタデータとルーティングのみ**（シークレットは含まない）。
- レガシーのインポートのみ対応する OAuth ファイル: `~/.openclaw/credentials/oauth.json`（初回使用時に `auth-profiles.json` にインポートされる）。

詳細: [/concepts/oauth](/concepts/oauth)

認証情報の種類:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（一部プロバイダーでは `projectId`/`enterpriseUrl` も含む）

## プロフィール ID

OAuth ログインは複数のアカウントが共存できるよう、個別のプロフィールを作成します。

- デフォルト: メールが利用できない場合は `provider:default`。
- メール付き OAuth: `provider:<email>`（例: `google-antigravity:user@gmail.com`）。

プロフィールは `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` の `profiles` 以下に保存されます。

## ローテーション順序

プロバイダーに複数のプロフィールがある場合、OpenClaw は以下の順序で選択します。

1. **明示的な設定**: `auth.order[provider]`（設定されている場合）。
2. **設定済みプロフィール**: プロバイダーでフィルタリングされた `auth.profiles`。
3. **保存済みプロフィール**: プロバイダーの `auth-profiles.json` 内のエントリ。

明示的な順序が設定されていない場合、OpenClaw はラウンドロビン順を使用します。

- **第一キー**: プロフィールの種類（**API キーより OAuth を優先**）。
- **第二キー**: `usageStats.lastUsed`（各種類内で最も古いものを優先）。
- **クールダウン中/無効なプロフィール**は末尾に移動され、期限切れが早いものから順に並べられます。

### セッションの固定（キャッシュフレンドリー）

OpenClaw はプロバイダーのキャッシュを温かく保つため、**セッションごとに選択した認証プロフィールを固定**します。すべてのリクエストでローテーションはしません。固定されたプロフィールは以下の場合まで再利用されます。

- セッションがリセットされた（`/new` / `/reset`）
- コンパクションが完了した（コンパクション回数が増加した）
- プロフィールがクールダウン中/無効

`/model …@<profileId>` による手動選択は、そのセッションの**ユーザーオーバーライド**を設定し、新しいセッションが開始されるまで自動ローテーションされません。

自動固定されたプロフィール（セッションルーターが選択したもの）は**優先**として扱われます。最初に試されますが、レート制限/タイムアウト時に OpenClaw は別のプロフィールにローテーションする場合があります。ユーザーが固定したプロフィールはそのプロフィールにロックされます。失敗してモデルフォールバックが設定されている場合は、プロフィールを切り替えるのではなく次のモデルに移行します。

### OAuth が「失われたように見える」理由

同じプロバイダーの OAuth プロフィールと API キープロフィールの両方がある場合、固定されていない限り、ラウンドロビンがメッセージをまたいで切り替えることがあります。単一のプロフィールを強制するには以下を行ってください。

- `auth.order[provider] = ["provider:profileId"]` で固定する。または
- UI/チャットサーフェスがサポートしている場合は `/model …` でプロフィールオーバーライドを使ってセッションごとにオーバーライドする。

## クールダウン

認証/レート制限エラー（またはレート制限に見えるタイムアウト）でプロフィールが失敗すると、OpenClaw はそれをクールダウン状態にマークして次のプロフィールに移動します。フォーマット/無効リクエストエラー（例: Cloud Code Assist のツール呼び出し ID 検証の失敗）もフェイルオーバーの対象として扱われ、同じクールダウンを使用します。

クールダウンは指数バックオフを使用します。

- 1 分
- 5 分
- 25 分
- 1 時間（上限）

ステートは `auth-profiles.json` の `usageStats` 以下に保存されます。

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

## 課金の無効化

課金/クレジットの失敗（例: 「クレジット不足」/「クレジット残高が低すぎる」）はフェイルオーバーの対象として扱われますが、通常は一時的なものではありません。短いクールダウンの代わりに、OpenClaw はプロフィールを**無効**としてマーク（より長いバックオフを使用）し、次のプロフィール/プロバイダーにローテーションします。

ステートは `auth-profiles.json` に保存されます。

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

- 課金バックオフは**5 時間**から始まり、課金失敗ごとに 2 倍になり、**24 時間**で上限に達します。
- プロフィールが**24 時間**失敗していない場合、バックオフカウンターがリセットされます（設定可能）。

## モデルフォールバック

プロバイダーのすべてのプロフィールが失敗した場合、OpenClaw は `agents.defaults.model.fallbacks` の次のモデルに移動します。これは認証失敗、レート制限、およびプロフィールローテーションを使い果たしたタイムアウトに適用されます（その他のエラーはフォールバックを進めません）。

モデルオーバーライド（フックまたは CLI）でランが開始された場合でも、設定されたフォールバックをすべて試した後、`agents.defaults.model.primary` で終了します。

## 関連設定

以下については[Gateway 設定](/gateway/configuration)を参照してください。

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` のルーティング

モデル選択とフォールバックの概要については[モデル](/concepts/models)を参照してください。
