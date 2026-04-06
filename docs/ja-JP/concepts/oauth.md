---
read_when:
    - OpenClawのOAuthをエンドツーエンドで理解したい場合
    - トークンの無効化/ログアウトの問題に遭遇した場合
    - setup-tokenまたはOAuth認証フローについて知りたい場合
    - 複数アカウントまたはプロファイルルーティングが必要な場合
summary: 'OpenClawにおけるOAuth: トークン交換、保存、マルチアカウントパターン'
title: OAuth
x-i18n:
    generated_at: "2026-04-02T07:38:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9de67a0e5a7b205cf7f930c593c6111f1675611f5b58b1ccda218ddfd989d026
    source_path: concepts/oauth.md
    workflow: 15
---

# OAuth

OpenClawは、OAuthを提供するプロバイダー（特に **OpenAI Codex（ChatGPT OAuth）**）向けに「サブスクリプション認証」をサポートしています。Anthropicサブスクリプションについては、**setup-token**フローを使用するか、Gateway ゲートウェイホスト上のローカル**Claude CLI**ログインを再利用できます。Claude Code外でのAnthropicサブスクリプション利用は、過去に一部のユーザーで制限されたことがあるため、ユーザー自身のリスク判断として扱い、現行のAnthropicポリシーをご自身で確認してください。OpenAI Codex OAuthは、OpenClawのような外部ツールでの使用が明示的にサポートされています。このページでは以下を説明します:

Anthropicの本番環境では、サブスクリプションのsetup-token認証よりもAPIキー認証がより安全な推奨パスです。

- OAuth **トークン交換**の仕組み（PKCE）
- トークンの**保存場所**（とその理由）
- **複数アカウント**の扱い方（プロファイル + セッションごとのオーバーライド）

OpenClawは、独自のOAuthまたはAPIキーフローを持つ**プロバイダープラグイン**もサポートしています。以下で実行します:

```bash
openclaw models auth login --provider <id>
```

## トークンシンク（なぜ存在するのか）

OAuthプロバイダーは通常、ログイン/リフレッシュフロー中に**新しいリフレッシュトークン**を発行します。一部のプロバイダー（またはOAuthクライアント）は、同じユーザー/アプリに対して新しいトークンが発行されると、古いリフレッシュトークンを無効化することがあります。

実際の症状:

- OpenClaw _および_ Claude Code / Codex CLIの両方でログインすると、後でどちらかがランダムに「ログアウト」される

これを軽減するため、OpenClawは `auth-profiles.json` を**トークンシンク**として扱います:

- ランタイムは**1つの場所**から認証情報を読み取る
- 複数のプロファイルを保持し、決定的にルーティングできる

## ストレージ（トークンの保存場所）

シークレットは**エージェントごと**に保存されます:

- 認証プロファイル（OAuth + APIキー + オプションの値レベルref）: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- レガシー互換ファイル: `~/.openclaw/agents/<agentId>/agent/auth.json`
  （静的な `api_key` エントリは検出時にスクラブされます）

レガシーインポート専用ファイル（引き続きサポートされますが、メインストアではありません）:

- `~/.openclaw/credentials/oauth.json`（初回使用時に `auth-profiles.json` にインポートされます）

上記すべて `$OPENCLAW_STATE_DIR`（状態ディレクトリのオーバーライド）にも対応しています。完全なリファレンス: [/gateway/configuration](/gateway/configuration-reference#auth-storage)

静的シークレットrefとランタイムスナップショットのアクティベーション動作については、[シークレット管理](/gateway/secrets)を参照してください。

## Anthropic setup-token（サブスクリプション認証）

<Warning>
Anthropicのsetup-tokenサポートは技術的な互換性であり、ポリシー上の保証ではありません。
Anthropicは過去にClaude Code外でのサブスクリプション利用をブロックしたことがあります。
サブスクリプション認証を使用するかどうかはご自身で判断し、Anthropicの現行規約を確認してください。
</Warning>

任意のマシンで `claude setup-token` を実行し、OpenClawに貼り付けます:

```bash
openclaw models auth setup-token --provider anthropic
```

別の場所でトークンを生成した場合は、手動で貼り付けます:

```bash
openclaw models auth paste-token --provider anthropic
```

確認:

```bash
openclaw models status
```

## Anthropic Claude CLI移行

Gateway ゲートウェイホストにClaude CLIが既にインストールされサインイン済みの場合、Anthropicのモデル選択をローカルCLIバックエンドに切り替えることができます:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
```

オンボーディングショートカット:

```bash
openclaw onboard --auth-choice anthropic-cli
```

これにより、既存のAnthropic認証プロファイルはロールバック用に保持されますが、メインのデフォルトモデルパスが `anthropic/...` から `claude-cli/...` に書き換えられます。

## OAuth交換（ログインの仕組み）

OpenClawのインタラクティブログインフローは `@mariozechner/pi-ai` で実装され、ウィザード/コマンドに接続されています。

### Anthropic setup-token / Claude CLI

フローの形状:

setup-tokenパス:

1. `claude setup-token` を実行する
2. トークンをOpenClawに貼り付ける
3. トークン認証プロファイルとして保存する（リフレッシュなし）

Claude CLIパス:

1. Gateway ゲートウェイホストで `claude auth login` でサインインする
2. `openclaw models auth login --provider anthropic --method cli --set-default` を実行する
3. 新しい認証プロファイルは保存しない。モデル選択を `claude-cli/...` に切り替える

ウィザードパス:

- `openclaw onboard` → 認証選択 `anthropic-cli`
- `openclaw onboard` → 認証選択 `setup-token`（Anthropic）

### OpenAI Codex（ChatGPT OAuth）

OpenAI Codex OAuthは、Codex CLI以外（OpenClawワークフローを含む）での使用が明示的にサポートされています。

フローの形状（PKCE）:

1. PKCE検証子/チャレンジ + ランダム `state` を生成する
2. `https://auth.openai.com/oauth/authorize?...` を開く
3. `http://127.0.0.1:1455/auth/callback` でコールバックのキャプチャを試みる
4. コールバックがバインドできない場合（またはリモート/ヘッドレスの場合）、リダイレクトURL/コードを貼り付ける
5. `https://auth.openai.com/oauth/token` で交換する
6. アクセストークンから `accountId` を抽出し、`{ access, refresh, expires, accountId }` を保存する

ウィザードパスは `openclaw onboard` → 認証選択 `openai-codex` です。

## リフレッシュ + 有効期限

プロファイルには `expires` タイムスタンプが保存されます。

ランタイム時:

- `expires` が未来の場合 → 保存されたアクセストークンを使用する
- 期限切れの場合 → リフレッシュ（ファイルロック下で）し、保存された認証情報を上書きする

リフレッシュフローは自動的に行われます。通常、トークンを手動で管理する必要はありません。

## 複数アカウント（プロファイル） + ルーティング

2つのパターンがあります:

### 1) 推奨: エージェントの分離

「個人」と「仕事」を完全に分離したい場合は、分離されたエージェント（別々のセッション + 認証情報 + ワークスペース）を使用します:

```bash
openclaw agents add work
openclaw agents add personal
```

その後、エージェントごとに認証を設定し（ウィザード）、チャットを適切なエージェントにルーティングします。

### 2) 上級: 1つのエージェントに複数のプロファイル

`auth-profiles.json` は同じプロバイダーに対して複数のプロファイルIDをサポートしています。

使用するプロファイルの選択:

- 設定の順序によるグローバル指定（`auth.order`）
- セッションごとの `/model ...@<profileId>` による指定

例（セッションオーバーライド）:

- `/model Opus@anthropic:work`

既存のプロファイルIDの確認方法:

- `openclaw channels list --json`（`auth[]` が表示されます）

関連ドキュメント:

- [/concepts/model-failover](/concepts/model-failover)（ローテーション + クールダウンルール）
- [/tools/slash-commands](/tools/slash-commands)（コマンドサーフェス）

## 関連

- [認証](/gateway/authentication) — モデルプロバイダー認証の概要
- [シークレット](/gateway/secrets) — 認証情報の保存とSecretRef
- [設定リファレンス](/gateway/configuration-reference#auth-storage) — 認証設定キー
