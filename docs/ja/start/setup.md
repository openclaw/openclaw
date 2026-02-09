---
summary: "OpenClaw の高度なセットアップおよび開発ワークフロー"
read_when:
  - 新しいマシンをセットアップするとき
  - 個人のセットアップを壊さずに「最新 + 最良」を使いたいとき
title: "セットアップ"
---

# セットアップ

<Note>
12. 初めてセットアップする場合は、[Getting Started](/start/getting-started) から始めてください。

初めてセットアップする場合は、[Getting Started](/start/getting-started) から始めてください。
ウィザードの詳細は、[Onboarding Wizard](/start/wizard) を参照してください。

</Note>

最終更新日: 2026-01-01

## TL;DR

- **カスタマイズはリポジトリの外に置く:** `~/.openclaw/workspace`（ワークスペース）+ `~/.openclaw/openclaw.json`（設定）。
- **安定ワークフロー:** macOS アプリをインストールし、同梱の Gateway を実行させます。
- **最先端ワークフロー:** `pnpm gateway:watch` で Gateway を自分で実行し、その後 macOS アプリを Local モードで接続します。

## 前提条件（ソースから）

- Node `>=22`
- `pnpm`
- Docker（任意。コンテナ化セットアップ／E2E のみ — [Docker](/install/docker) を参照）

## カスタマイズ戦略（更新で壊さないために）

「自分向けに 100% カスタマイズ」しつつ、更新を簡単にしたい場合は、次の場所にカスタマイズを保持します。

- **設定:** `~/.openclaw/openclaw.json`（JSON/JSON5 風）
- **ワークスペース:** `~/.openclaw/workspace`（Skills、プロンプト、メモリ。プライベートな git リポジトリにします）

ブートストラップ:

```bash
openclaw setup
```

このリポジトリ内から、ローカルの CLI エントリを使用します。

```bash
openclaw setup
```

まだグローバルインストールがない場合は、`pnpm openclaw setup` で実行してください。

## このリポジトリから Gateway を実行

`pnpm build` の後、パッケージ化された CLI を直接実行できます。

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 安定ワークフロー（macOS アプリ優先）

1. **OpenClaw.app**（メニューバー）をインストールして起動します。
2. オンボーディング／権限チェックリスト（TCC プロンプト）を完了します。
3. Gateway が **Local** で実行中であることを確認します（アプリが管理します）。
4. サーフェスをリンクします（例: WhatsApp）。

```bash
openclaw channels login
```

5. 動作確認:

```bash
openclaw health
```

ビルドでオンボーディングが利用できない場合:

- `openclaw setup` を実行し、次に `openclaw channels login` を実行してから、Gateway を手動で起動します（`openclaw gateway`）。

## 最先端ワークフロー（ターミナルで Gateway）

目的: TypeScript の Gateway を作業し、ホットリロードを有効にしつつ、macOS アプリの UI を接続したままにします。

### 0)（任意）macOS アプリもソースから実行

macOS アプリも最先端にしたい場合:

```bash
./scripts/restart-mac.sh
```

### 1. 開発用 Gateway を起動

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` は、Gateway をウォッチモードで実行し、TypeScript の変更時に再読み込みします。

### 2. macOS アプリを実行中の Gateway に向ける

**OpenClaw.app** で:

- 接続モード: **Local**
  アプリは、設定されたポートで実行中の Gateway に接続します。

### 3. 確認

- アプリ内の Gateway ステータスが **「Using existing gateway …」** と表示されること。
- もしくは CLI で確認します。

```bash
openclaw health
```

### 一般的なフットガン

- **ポート違い:** Gateway の WS のデフォルトは `ws://127.0.0.1:18789` です。アプリと CLI を同じポートに揃えてください。
- **状態の保存先:**
  - 認証情報: `~/.openclaw/credentials/`
  - セッション: `~/.openclaw/agents/<agentId>/sessions/`
  - ログ: `/tmp/openclaw/`

## 認証情報の保存マップ

認証のデバッグやバックアップ対象の判断に使用します。

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: 設定／環境変数、または `channels.telegram.tokenFile`
- **Discord bot token**: 設定／環境変数（トークンファイルは未対応）
- **Slack tokens**: 設定／環境変数（`channels.slack.*`）
- **ペアリング許可リスト**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **モデル認証プロファイル**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **レガシー OAuth のインポート**: `~/.openclaw/credentials/oauth.json`
  詳細: [Security](/gateway/security#credential-storage-map)。

## 更新（セットアップを壊さずに）

- `~/.openclaw/workspace` と `~/.openclaw/` を「自分のもの」として維持し、個人のプロンプト／設定を `openclaw` リポジトリに入れないでください。
- ソースの更新: `git pull` + `pnpm install`（ロックファイルが変更された場合）+ 引き続き `pnpm gateway:watch` を使用します。

## Linux（systemd ユーザーサービス）

Linux installsはsystemd **user** サービスを使用します。 デフォルトでは、systemd はログアウト/アイドル時にユーザー
サービスを停止し、ゲートウェイを停止します。
を長引かせるためのオンボーディングを試みます (sudoのプロンプトが表示される場合があります)。 それがまだオフの場合は、次を実行してください。

```bash
sudo loginctl enable-linger $USER
```

常時稼働やマルチユーザーのサーバーでは、ユーザーサービスではなく **システム** サービスの使用を検討してください（lingering は不要）。systemd に関する注意点は、[Gateway runbook](/gateway) を参照してください。 13. systemd に関する注意事項については、[Gateway runbook](/gateway) を参照してください。

## 関連ドキュメント

- [Gateway runbook](/gateway)（フラグ、監視、ポート）
- [Gateway configuration](/gateway/configuration)（設定スキーマ + 例）
- [Discord](/channels/discord) および [Telegram](/channels/telegram)（返信タグ + replyToMode 設定）
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos)（Gateway のライフサイクル）
