---
read_when:
    - 新しいマシンのセットアップ
    - 個人のセットアップを壊さずに「最新かつ最良」を使いたい
summary: OpenClawの高度なセットアップと開発ワークフロー
title: セットアップ
x-i18n:
    generated_at: "2026-04-02T07:55:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6c489f3f611334b3e25c10d44da6bf58946c1a585608d1463a2c89ecd00f1dfd
    source_path: start/setup.md
    workflow: 15
---

# セットアップ

<Note>
初めてセットアップする場合は、[はじめに](/start/getting-started)から始めてください。
オンボーディングの詳細は、[セットアップウィザード（CLI）](/start/wizard)を参照してください。
</Note>

## 要約

- **カスタマイズはリポジトリ外に保存:** `~/.openclaw/workspace`（ワークスペース）+ `~/.openclaw/openclaw.json`（設定）。
- **安定版ワークフロー:** macOSアプリをインストールし、バンドルされたGateway ゲートウェイを実行させます。
- **最先端ワークフロー:** `pnpm gateway:watch`でGateway ゲートウェイを自分で実行し、macOSアプリをローカルモードで接続させます。

## 前提条件（ソースから）

- Node 24推奨（Node 22 LTS、現在`22.14+`もサポート）
- `pnpm`
- Docker（オプション。コンテナ化されたセットアップ/e2e用のみ — [Docker](/install/docker)を参照）

## カスタマイズ戦略（更新で壊れないように）

「自分に100%カスタマイズ」しつつ簡単に更新したい場合は、カスタマイズを以下に保存してください：

- **設定:** `~/.openclaw/openclaw.json`（JSON/JSON5形式）
- **ワークスペース:** `~/.openclaw/workspace`（Skills、プロンプト、メモリ。プライベートgitリポジトリにすることを推奨）

初回のブートストラップ：

```bash
openclaw setup
```

このリポジトリ内からは、ローカルCLIエントリを使用します：

```bash
openclaw setup
```

グローバルインストールがまだない場合は、`pnpm openclaw setup`で実行してください。

## このリポジトリからGateway ゲートウェイを実行する

`pnpm build`の後、パッケージ化されたCLIを直接実行できます：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 安定版ワークフロー（macOSアプリ優先）

1. **OpenClaw.app**をインストールして起動（メニューバー）。
2. オンボーディング/権限チェックリストを完了（TCCプロンプト）。
3. Gateway ゲートウェイが**ローカル**で実行中であることを確認（アプリが管理します）。
4. サーフェスを接続（例: WhatsApp）：

```bash
openclaw channels login
```

5. インストール確認：

```bash
openclaw health
```

お使いのビルドでオンボーディングが利用できない場合：

- `openclaw setup`を実行し、次に`openclaw channels login`、その後Gateway ゲートウェイを手動で起動します（`openclaw gateway`）。

## 最先端ワークフロー（ターミナルでGateway ゲートウェイを実行）

目標: TypeScript Gateway ゲートウェイで開発し、ホットリロードを利用し、macOSアプリのUIを接続したままにする。

### 0）（オプション）macOSアプリもソースから実行

macOSアプリも最先端にしたい場合：

```bash
./scripts/restart-mac.sh
```

### 1）開発用Gateway ゲートウェイを起動

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch`はGateway ゲートウェイをウォッチモードで実行し、関連するソース、設定、バンドルプラグインのメタデータの変更時にリロードします。

### 2）macOSアプリを実行中のGateway ゲートウェイに接続

**OpenClaw.app**で：

- 接続モード: **ローカル**
  アプリは設定されたポートで実行中のGateway ゲートウェイに接続します。

### 3）確認

- アプリ内のGateway ゲートウェイステータスが**「Using existing gateway …」**と表示されるはずです
- またはCLI経由で：

```bash
openclaw health
```

### よくある落とし穴

- **ポートが間違っている:** Gateway ゲートウェイのWSはデフォルトで`ws://127.0.0.1:18789`です。アプリとCLIを同じポートに合わせてください。
- **ステートの保存場所:**
  - 認証情報: `~/.openclaw/credentials/`
  - セッション: `~/.openclaw/agents/<agentId>/sessions/`
  - ログ: `/tmp/openclaw/`

## 認証情報の保存場所マップ

認証のデバッグやバックアップ対象を決める際に使用してください：

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegramボットトークン**: 設定/環境変数または`channels.telegram.tokenFile`（通常のファイルのみ。シンボリックリンクは拒否されます）
- **Discordボットトークン**: 設定/環境変数またはSecretRef（env/file/execプロバイダー）
- **Slackトークン**: 設定/環境変数（`channels.slack.*`）
- **ペアリング許可リスト**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json`（デフォルトアカウント）
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json`（デフォルト以外のアカウント）
- **モデル認証プロファイル**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **ファイルベースのシークレットペイロード（オプション）**: `~/.openclaw/secrets.json`
- **レガシーOAuthインポート**: `~/.openclaw/credentials/oauth.json`
  詳細: [セキュリティ](/gateway/security#credential-storage-map)。

## 更新する（セットアップを壊さずに）

- `~/.openclaw/workspace`と`~/.openclaw/`を「自分のもの」として保持し、個人のプロンプト/設定を`openclaw`リポジトリに入れないでください。
- ソースの更新: `git pull` + `pnpm install`（ロックファイルが変更された場合）+ 引き続き`pnpm gateway:watch`を使用。

## Linux（systemdユーザーサービス）

Linuxインストールではsystemdの**ユーザー**サービスを使用します。デフォルトでは、systemdはログアウト/アイドル時にユーザーサービスを停止するため、Gateway ゲートウェイが終了します。オンボーディングは自動的にlingeringを有効にしようとします（sudoのプロンプトが表示される場合があります）。まだ無効の場合は、以下を実行してください：

```bash
sudo loginctl enable-linger $USER
```

常時稼働またはマルチユーザーサーバーの場合は、ユーザーサービスの代わりに**システム**サービスを検討してください（lingeringは不要）。systemdに関する注意事項は[Gateway ゲートウェイ運用ガイド](/gateway)を参照してください。

## 関連ドキュメント

- [Gateway ゲートウェイ運用ガイド](/gateway)（フラグ、監視、ポート）
- [Gateway ゲートウェイ設定](/gateway/configuration)（設定スキーマと例）
- [Discord](/channels/discord)と[Telegram](/channels/telegram)（返信タグとreplyToMode設定）
- [OpenClawアシスタントのセットアップ](/start/openclaw)
- [macOSアプリ](/platforms/macos)（Gateway ゲートウェイのライフサイクル）
