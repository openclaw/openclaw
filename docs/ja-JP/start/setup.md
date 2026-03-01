---
summary: "OpenClawの高度なセットアップと開発ワークフロー"
read_when:
  - 新しいマシンをセットアップする
  - 個人のセットアップを壊さずに最新版を使いたい
title: "セットアップ"
---

# セットアップ

<Note>
初めてセットアップする場合は、[はじめに](/start/getting-started)から始めてください。
ウィザードの詳細は[オンボーディングウィザード](/start/wizard)をご覧ください。
</Note>

最終更新: 2026-01-01

## 要約

- **カスタマイズはリポジトリ外に配置:** `~/.openclaw/workspace`（ワークスペース）+ `~/.openclaw/openclaw.json`（設定）。
- **安定版ワークフロー:** macOSアプリをインストールし、バンドルされたGatewayを実行させます。
- **最新版ワークフロー:** `pnpm gateway:watch` で自分でGatewayを実行し、macOSアプリをローカルモードでアタッチします。

## 前提条件（ソースから）

- Node `>=22`
- `pnpm`
- Docker（オプション。コンテナ化セットアップ/e2e用のみ -- [Docker](/install/docker) を参照）

## カスタマイズ戦略（アップデートの影響を最小化）

「100%自分に合わせた設定」_かつ_簡単なアップデートを望む場合、カスタマイズは以下に保管してください：

- **設定:** `~/.openclaw/openclaw.json`（JSON/JSON5風）
- **ワークスペース:** `~/.openclaw/workspace`（スキル、プロンプト、メモリー。プライベートgitリポジトリにしましょう）

ブートストラップを一度実行：

```bash
openclaw setup
```

このリポジトリ内からは、ローカルCLIエントリを使用します：

```bash
openclaw setup
```

グローバルインストールがまだない場合は、`pnpm openclaw setup` で実行してください。

## このリポジトリからGatewayを実行

`pnpm build` の後、パッケージ化されたCLIを直接実行できます：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 安定版ワークフロー（macOSアプリ優先）

1. **OpenClaw.app**をインストールして起動します（メニューバー）。
2. オンボーディング/パーミッションチェックリストを完了します（TCCプロンプト）。
3. Gatewayが**ローカル**で実行中であることを確認します（アプリが管理します）。
4. サーフェスをリンクします（例: WhatsApp）：

```bash
openclaw channels login
```

5. 動作確認：

```bash
openclaw health
```

お使いのビルドでオンボーディングが利用できない場合：

- `openclaw setup` を実行し、次に `openclaw channels login`、その後手動でGatewayを起動します（`openclaw gateway`）。

## 最新版ワークフロー（ターミナルでGateway）

目標: TypeScript Gatewayを開発し、ホットリロードを得ながら、macOSアプリのUIをアタッチしたままにします。

### 0) （オプション）macOSアプリもソースから実行

macOSアプリも最新版にしたい場合：

```bash
./scripts/restart-mac.sh
```

### 1) 開発用Gatewayを起動

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` はウォッチモードでGatewayを実行し、TypeScriptの変更時にリロードします。

### 2) macOSアプリを実行中のGatewayに接続

**OpenClaw.app** で：

- 接続モード: **ローカル**
  アプリは設定されたポートの実行中のGatewayにアタッチします。

### 3) 確認

- アプリ内のGatewayステータスに **「Using existing gateway ...」** と表示されます
- またはCLIで：

```bash
openclaw health
```

### よくある落とし穴

- **ポートの不一致:** Gateway WSはデフォルトで `ws://127.0.0.1:18789`。アプリとCLIを同じポートに設定してください。
- **状態の保存先:**
  - クレデンシャル: `~/.openclaw/credentials/`
  - セッション: `~/.openclaw/agents/<agentId>/sessions/`
  - ログ: `/tmp/openclaw/`

## クレデンシャル保存マップ

認証のデバッグやバックアップ対象の決定時に使用してください：

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegramボットトークン**: 設定/環境変数または `channels.telegram.tokenFile`
- **Discordボットトークン**: 設定/環境変数（トークンファイルはまだサポートされていません）
- **Slackトークン**: 設定/環境変数（`channels.slack.*`）
- **ペアリング許可リスト**:
  - `~/.openclaw/credentials/<channel>-allowFrom.json`（デフォルトアカウント）
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json`（非デフォルトアカウント）
- **モデル認証プロファイル**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **ファイルベースシークレットペイロード（オプション）**: `~/.openclaw/secrets.json`
- **レガシーOAuthインポート**: `~/.openclaw/credentials/oauth.json`
  詳細: [セキュリティ](/gateway/security#credential-storage-map)。

## アップデート（セットアップを壊さずに）

- `~/.openclaw/workspace` と `~/.openclaw/` を「自分のもの」として保管してください。個人のプロンプト/設定を `openclaw` リポジトリに入れないでください。
- ソースのアップデート: `git pull` + `pnpm install`（ロックファイルが変更された場合）+ 引き続き `pnpm gateway:watch` を使用。

## Linux（systemdユーザーサービス）

Linuxインストールではsystemd**ユーザー**サービスを使用します。デフォルトでは、systemdはログアウト/アイドル時にユーザーサービスを停止し、Gatewayが終了します。オンボーディングはリンガリングの有効化を試みます（sudoのプロンプトが表示される場合があります）。まだ無効な場合は以下を実行してください：

```bash
sudo loginctl enable-linger $USER
```

常時稼働やマルチユーザーサーバーの場合は、ユーザーサービスの代わりに**システム**サービスを検討してください（リンガリング不要）。systemdに関するノートは[Gatewayランブック](/gateway)をご覧ください。

## 関連ドキュメント

- [Gatewayランブック](/gateway)（フラグ、スーパービジョン、ポート）
- [Gateway設定](/gateway/configuration)（設定スキーマと例）
- [Discord](/channels/discord) と [Telegram](/channels/telegram)（リプライタグとreplyToMode設定）
- [OpenClawアシスタントセットアップ](/ja-JP/start/openclaw)
- [macOSアプリ](/platforms/macos)（Gatewayライフサイクル）
