---
summary: "OpenClaw における OAuth：トークン交換、保存、および複数アカウントのパターン"
read_when:
  - OpenClaw の OAuth をエンドツーエンドで理解したい場合
  - トークン無効化／ログアウトの問題に直面した場合
  - setup-token または OAuth の認証フローを設定したい場合
  - 複数アカウントやプロファイルルーティングを行いたい場合
title: "OAuth"
---

# OAuth

OpenClaw は、提供しているプロバイダーに対して OAuth による「subscription auth」をサポートします（特に **OpenAI Codex（ChatGPT OAuth）**）。Anthropic のサブスクリプションについては **setup-token** フローを使用してください。本ページでは次を説明します。 Anthropic サブスクリプションの場合は、**setup-token** フローを使用します。 このページは以下のように説明しています。

- OAuth の **トークン交換** の仕組み（PKCE）
- トークンが **保存** される場所（およびその理由）
- **複数アカウント** の扱い方（プロファイル + セッション単位のオーバーライド）

OpenClaw は、独自の OAuth または API キーのフローを提供する **provider plugins** もサポートします。次で実行してください。 以下で実行します：

```bash
openclaw models auth login --provider <id>
```

## トークンシンク（存在理由）

OAuth プロバイダーは、ログイン／更新フロー中に **新しいリフレッシュトークン** を発行するのが一般的です。一部のプロバイダー（または OAuth クライアント）では、同一ユーザー／アプリに対して新しいトークンが発行されると、古いリフレッシュトークンが無効化されることがあります。 いくつかのプロバイダー (または OAuth クライアント) は、同じユーザ/アプリケーションに対して新しいものが発行された場合、古い更新トークンを無効にできます。

実際の症状：

- OpenClaw _と_ Claude Code／Codex CLI の両方でログインすると、後になってどちらかがランダムに「ログアウト」される

これを軽減するため、OpenClaw は `auth-profiles.json` を **トークンシンク** として扱います。

- ランタイムは **1 か所** から認証情報を読み取ります
- 複数のプロファイルを保持し、決定的にルーティングできます

## ストレージ（トークンの保存場所）

シークレットは**エージェントごと**に保存されます。

- 認証プロファイル（OAuth + API キー）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- ランタイムキャッシュ（自動管理；編集しないでください）：`~/.openclaw/agents/<agentId>/agent/auth.json`

レガシーのインポート専用ファイル（引き続きサポートされますが、主要ストアではありません）：

- `~/.openclaw/credentials/oauth.json`（初回使用時に `auth-profiles.json` へインポート）

上記のすべても、`$OPENCLAW_STATE_DIR`（状態は上書きされます）を尊重します。 上記はすべて `$OPENCLAW_STATE_DIR`（状態ディレクトリのオーバーライド）にも対応します。完全なリファレンス：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token（subscription auth）

任意のマシンで `claude setup-token` を実行し、その結果を OpenClaw に貼り付けます。

```bash
openclaw models auth setup-token --provider anthropic
```

別の場所でトークンを生成した場合は、手動で貼り付けてください。

```bash
openclaw models auth paste-token --provider anthropic
```

確認：

```bash
openclaw models status
```

## OAuth 交換（ログインの仕組み）

OpenClaw の対話型ログインフローは `@mariozechner/pi-ai` に実装され、ウィザード／コマンドに接続されています。

### Anthropic（Claude Pro/Max）setup-token

フローの形：

1. `claude setup-token` を実行
2. トークンを OpenClaw に貼り付け
3. トークン認証プロファイルとして保存（更新なし）

ウィザードの経路は `openclaw onboard` → 認証の選択 `setup-token`（Anthropic）です。

### OpenAI Codex（ChatGPT OAuth）

フローの形（PKCE）：

1. PKCE の verifier／challenge とランダムな `state` を生成
2. `https://auth.openai.com/oauth/authorize?...` を開く
3. `http://127.0.0.1:1455/auth/callback` でコールバックの捕捉を試行
4. コールバックをバインドできない場合（またはリモート／ヘッドレスの場合）は、リダイレクト URL／コードを貼り付け
5. `https://auth.openai.com/oauth/token` で交換
6. アクセストークンから `accountId` を抽出し、`{ access, refresh, expires, accountId }` を保存

ウィザードの経路は `openclaw onboard` → 認証の選択 `openai-codex` です。

## 更新 + 期限切れ

プロファイルは `expires` のタイムスタンプを保存します。

実行時:

- `expires` が将来であれば → 保存されているアクセストークンを使用
- 期限切れの場合 →（ファイルロック下で）更新し、保存されている認証情報を上書き

更新フローは自動です。通常、トークンを手動で管理する必要はありません。

## 複数アカウント（プロファイル）+ ルーティング

2 つのパターンがあります。

### 1. 推奨：エージェントを分離

「個人」と「業務」を決して相互に影響させたくない場合は、分離されたエージェント（セッション + 認証情報 + ワークスペースを分離）を使用してください。

```bash
openclaw agents add work
openclaw agents add personal
```

その後、エージェントごとに認証を設定（ウィザード）し、適切なエージェントへチャットをルーティングします。

### 2. 上級：1 つのエージェントで複数プロファイル

`auth-profiles.json` は、同一プロバイダーに対して複数のプロファイル ID をサポートします。

使用するプロファイルの選択方法：

- 設定の順序によるグローバル指定（`auth.order`）
- セッション単位での指定（`/model ...@<profileId>`）

例（セッションのオーバーライド）：

- `/model Opus@anthropic:work`

存在するプロファイル ID の確認方法：

- `openclaw channels list --json`（`auth[]` を表示）

関連ドキュメント：

- [/concepts/model-failover](/concepts/model-failover)（ローテーション + クールダウンのルール）
- [/tools/slash-commands](/tools/slash-commands)（コマンドのインターフェース）
