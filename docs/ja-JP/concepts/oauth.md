---
summary: "OpenClaw の OAuth: トークン交換、ストレージ、マルチアカウントパターン"
read_when:
  - OpenClaw の OAuth をエンドツーエンドで理解したいとき
  - トークンの無効化やログアウトの問題が発生したとき
  - setup-token または OAuth 認証フローを使いたいとき
  - 複数のアカウントやプロフィールルーティングを使いたいとき
title: "OAuth"
---

# OAuth

OpenClaw は OAuth を提供するプロバイダー（特に **OpenAI Codex（ChatGPT OAuth）**）向けに「サブスクリプション認証」を OAuth でサポートします。Anthropic サブスクリプションには **setup-token** フローを使用してください。このページでは以下を説明します。

- OAuth の**トークン交換**がどのように機能するか（PKCE）
- トークンがどこに**保存**されるか（およびその理由）
- **複数のアカウント**をどのように処理するか（プロフィール + セッションごとのオーバーライド）

OpenClaw は独自の OAuth または API キーフローを搭載した**プロバイダープラグイン**もサポートします。以下で実行できます。

```bash
openclaw models auth login --provider <id>
```

## トークンシンク（なぜ存在するか）

OAuth プロバイダーは一般的にログイン/リフレッシュフロー中に**新しいリフレッシュトークン**を発行します。一部のプロバイダー（または OAuth クライアント）は、同じユーザー/アプリに対して新しいトークンが発行されると古いリフレッシュトークンを無効化することがあります。

実際の症状:

- OpenClaw と Claude Code / Codex CLI の両方でログインすると、後でどちらかがランダムに「ログアウト」する

これを軽減するために、OpenClaw は `auth-profiles.json` を**トークンシンク**として扱います。

- ランタイムは**一箇所**から認証情報を読み込みます。
- 複数のプロフィールを保持し、それらを決定論的にルーティングできます。

## ストレージ（トークンの保存場所）

シークレットは**エージェントごと**に保存されます。

- 認証プロフィール（OAuth + API キー + オプションの値レベル参照）: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- レガシー互換ファイル: `~/.openclaw/agents/<agentId>/agent/auth.json`
  （静的な `api_key` エントリは発見時に削除されます）

レガシーのインポートのみ対応するファイル（まだサポートされているが、メインストアではない）:

- `~/.openclaw/credentials/oauth.json`（初回使用時に `auth-profiles.json` にインポートされる）

上記はすべて `$OPENCLAW_STATE_DIR`（ステートディレクトリのオーバーライド）も考慮します。完全なリファレンス: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

静的シークレット参照とランタイムスナップショットのアクティベーション動作については[シークレット管理](/gateway/secrets)を参照してください。

## Anthropic setup-token（サブスクリプション認証）

任意のマシンで `claude setup-token` を実行してから OpenClaw に貼り付けます。

```bash
openclaw models auth setup-token --provider anthropic
```

他の場所でトークンを生成した場合は、手動で貼り付けます。

```bash
openclaw models auth paste-token --provider anthropic
```

確認:

```bash
openclaw models status
```

## OAuth 交換（ログインの仕組み）

OpenClaw のインタラクティブなログインフローは `@mariozechner/pi-ai` で実装され、ウィザード/コマンドに接続されています。

### Anthropic（Claude Pro/Max）setup-token

フローの形:

1. `claude setup-token` を実行します。
2. トークンを OpenClaw に貼り付けます。
3. トークン認証プロフィールとして保存します（リフレッシュなし）。

ウィザードのパスは `openclaw onboard` → 認証選択 `setup-token`（Anthropic）です。

### OpenAI Codex（ChatGPT OAuth）

フローの形（PKCE）:

1. PKCE ベリファイア/チャレンジ + ランダムな `state` を生成します。
2. `https://auth.openai.com/oauth/authorize?...` を開きます。
3. `http://127.0.0.1:1455/auth/callback` でコールバックのキャプチャを試みます。
4. コールバックをバインドできない場合（またはリモート/ヘッドレスの場合）、リダイレクト URL/コードを貼り付けます。
5. `https://auth.openai.com/oauth/token` で交換します。
6. アクセストークンから `accountId` を抽出して `{ access, refresh, expires, accountId }` を保存します。

ウィザードのパスは `openclaw onboard` → 認証選択 `openai-codex` です。

## リフレッシュと有効期限

プロフィールには `expires` タイムスタンプが保存されます。

ランタイムでは:

- `expires` が将来の時刻 → 保存されたアクセストークンを使用します。
- 期限切れ → リフレッシュ（ファイルロック下）して保存された認証情報を上書きします。

リフレッシュフローは自動です。通常はトークンを手動で管理する必要はありません。

## 複数のアカウント（プロフィール）とルーティング

2 つのパターンがあります。

### 1) 推奨: 個別のエージェント

「個人用」と「仕事用」が絶対に干渉しないようにしたい場合は、分離されたエージェント（個別のセッション + 認証情報 + ワークスペース）を使用します。

```bash
openclaw agents add work
openclaw agents add personal
```

次にエージェントごとに認証を設定（ウィザード）し、チャットを適切なエージェントにルーティングします。

### 2) 高度: 1 つのエージェント内の複数プロフィール

`auth-profiles.json` は同じプロバイダーに対して複数のプロフィール ID をサポートします。

使用するプロフィールを選択するには:

- 設定の順序でグローバルに（`auth.order`）
- セッションごとに `/model ...@<profileId>` で

例（セッションオーバーライド）:

- `/model Opus@anthropic:work`

存在するプロフィール ID を確認するには:

- `openclaw channels list --json`（`auth[]` が表示される）

関連ドキュメント:

- [/concepts/model-failover](/concepts/model-failover)（ローテーションとクールダウンルール）
- [/tools/slash-commands](/tools/slash-commands)（コマンドサーフェス）
