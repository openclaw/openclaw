---
title: Fly.io
description: Fly.ioにOpenClawをデプロイする
summary: "永続ストレージとHTTPSを備えたOpenClawのFly.ioデプロイメント手順"
read_when:
  - Fly.ioにOpenClawをデプロイする場合
  - Flyボリューム、シークレット、初回設定をセットアップする場合
---

# Fly.ioデプロイメント

**目標：** 永続ストレージ、自動HTTPS、およびDiscord/チャンネルアクセスを備えた[Fly.io](https://fly.io)マシン上でOpenClaw Gatewayを実行する。

## 必要なもの

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)がインストール済み
- Fly.ioアカウント（無料枠で利用可能）
- モデル認証：Anthropic APIキー（または他のプロバイダーキー）
- チャンネル認証情報：Discordボットトークン、Telegramトークンなど

## 初心者向けクイックパス

1. リポジトリをクローン → `fly.toml`をカスタマイズ
2. アプリ + ボリュームを作成 → シークレットを設定
3. `fly deploy`でデプロイ
4. SSHで接続して設定を作成、またはControl UIを使用

## 1）Flyアプリの作成

```bash
# リポジトリをクローン
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 新しいFlyアプリを作成（任意の名前を選択）
fly apps create my-openclaw

# 永続ボリュームを作成（1GBで通常十分）
fly volumes create openclaw_data --size 1 --region iad
```

**ヒント：** 近いリージョンを選択してください。一般的なオプション：`lhr`（ロンドン）、`iad`（バージニア）、`sjc`（サンノゼ）。

## 2）fly.tomlの設定

アプリ名と要件に合わせて`fly.toml`を編集してください。

**セキュリティに関する注意：** デフォルト設定はパブリックURLを公開します。パブリックIPなしの強化デプロイメントについては、[プライベートデプロイメント](#private-deployment-hardened)を参照するか、`fly.private.toml`を使用してください。

```toml
app = "my-openclaw"  # アプリ名
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**重要な設定：**

| 設定                        | 理由                                                                         |
| ------------------------------ | --------------------------------------------------------------------------- |
| `--bind lan`                   | `0.0.0.0`にバインドしてFlyのプロキシがGatewayに到達できるようにする                     |
| `--allow-unconfigured`         | 設定ファイルなしで起動（後で作成します）                      |
| `internal_port = 3000`         | Flyヘルスチェックのため`--port 3000`（または`OPENCLAW_GATEWAY_PORT`）と一致する必要がある |
| `memory = "2048mb"`            | 512MBでは小さすぎます。2GBを推奨                                         |
| `OPENCLAW_STATE_DIR = "/data"` | ボリューム上に状態を永続化                                                |

## 3）シークレットの設定

```bash
# 必須：Gatewayトークン（非ループバックバインドの場合）
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# モデルプロバイダーAPIキー
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# オプション：その他のプロバイダー
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# チャンネルトークン
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**注意：**

- 非ループバックバインド（`--bind lan`）はセキュリティのため`OPENCLAW_GATEWAY_TOKEN`が必要です。
- これらのトークンはパスワードと同様に扱ってください。
- **すべてのAPIキーとトークンは設定ファイルよりも環境変数を優先してください。** これにより、`openclaw.json`でのシークレットの意図しない公開やログ記録を防ぎます。

## 4）デプロイ

```bash
fly deploy
```

初回デプロイはDockerイメージをビルドします（約2-3分）。以降のデプロイはより高速です。

デプロイ後、確認してください：

```bash
fly status
fly logs
```

以下が表示されるはずです：

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5）設定ファイルの作成

マシンにSSHで接続して適切な設定を作成します：

```bash
fly ssh console
```

設定ディレクトリとファイルを作成します：

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**注意：** `OPENCLAW_STATE_DIR=/data`の場合、設定パスは`/data/openclaw.json`です。

**注意：** Discordトークンは以下のいずれかから取得できます：

- 環境変数：`DISCORD_BOT_TOKEN`（シークレットに推奨）
- 設定ファイル：`channels.discord.token`

環境変数を使用する場合、設定にトークンを追加する必要はありません。Gatewayは`DISCORD_BOT_TOKEN`を自動的に読み取ります。

適用するために再起動：

```bash
exit
fly machine restart <machine-id>
```

## 6）Gatewayへのアクセス

### Control UI

ブラウザで開く：

```bash
fly open
```

または`https://my-openclaw.fly.dev/`にアクセスしてください。

認証のためにGatewayトークン（`OPENCLAW_GATEWAY_TOKEN`のもの）を貼り付けてください。

### ログ

```bash
fly logs              # ライブログ
fly logs --no-tail    # 最近のログ
```

### SSHコンソール

```bash
fly ssh console
```

## トラブルシューティング

### 「App is not listening on expected address」

Gatewayが`0.0.0.0`ではなく`127.0.0.1`にバインドしています。

**修正：** `fly.toml`のプロセスコマンドに`--bind lan`を追加してください。

### ヘルスチェック失敗 / 接続拒否

FlyがGatewayの設定されたポートに到達できません。

**修正：** `internal_port`がGatewayポートと一致していることを確認してください（`--port 3000`または`OPENCLAW_GATEWAY_PORT=3000`を設定）。

### OOM / メモリの問題

コンテナが再起動を繰り返すか、killされます。兆候：`SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration`、またはサイレントリスタート。

**修正：** `fly.toml`のメモリを増やしてください：

```toml
[[vm]]
  memory = "2048mb"
```

または既存のマシンを更新：

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意：** 512MBでは小さすぎます。1GBは負荷時やverboseログ使用時にOOMする可能性があります。**2GBを推奨します。**

### Gatewayロックの問題

Gatewayが「already running」エラーで起動を拒否します。

コンテナが再起動してもPIDロックファイルがボリューム上に残っている場合に発生します。

**修正：** ロックファイルを削除：

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

ロックファイルは`/data/gateway.*.lock`にあります（サブディレクトリ内ではありません）。

### 設定が読み込まれない

`--allow-unconfigured`を使用している場合、Gatewayは最小限の設定を作成します。`/data/openclaw.json`のカスタム設定は再起動時に読み込まれるはずです。

設定が存在することを確認：

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH経由での設定の書き込み

`fly ssh console -C`コマンドはシェルリダイレクションをサポートしていません。設定ファイルを書き込むには：

```bash
# echo + teeを使用（ローカルからリモートへパイプ）
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# またはsftpを使用
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**注意：** ファイルが既に存在する場合、`fly sftp`は失敗する場合があります。先に削除してください：

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 状態が永続化されない

再起動後に認証情報やセッションが失われる場合、状態ディレクトリがコンテナファイルシステムに書き込まれています。

**修正：** `fly.toml`で`OPENCLAW_STATE_DIR=/data`が設定されていることを確認し、再デプロイしてください。

## アップデート

```bash
# 最新の変更を取得
git pull

# 再デプロイ
fly deploy

# ヘルスチェック
fly status
fly logs
```

### マシンコマンドの更新

フル再デプロイなしで起動コマンドを変更する必要がある場合：

```bash
# マシンIDを取得
fly machines list

# コマンドを更新
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# またはメモリ増加と一緒に
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注意：** `fly deploy`後、マシンコマンドは`fly.toml`の内容にリセットされる場合があります。手動で変更した場合は、デプロイ後に再適用してください。

## プライベートデプロイメント（強化版）

デフォルトでは、FlyはパブリックIPを割り当て、Gatewayが`https://your-app.fly.dev`でアクセス可能になります。これは便利ですが、インターネットスキャナー（Shodan、Censysなど）でデプロイメントが発見可能になることを意味します。

**パブリック公開なし**の強化デプロイメントには、プライベートテンプレートを使用してください。

### プライベートデプロイメントを使用する場合

- **アウトバウンド**の通話/メッセージのみ行う場合（インバウンドWebhookなし）
- Webhookコールバックに**ngrokまたはTailscale**トンネルを使用する場合
- ブラウザではなく**SSH、プロキシ、またはWireGuard**経由でGatewayにアクセスする場合
- デプロイメントを**インターネットスキャナーから隠したい**場合

### セットアップ

標準設定の代わりに`fly.private.toml`を使用してください：

```bash
# プライベート設定でデプロイ
fly deploy -c fly.private.toml
```

または既存のデプロイメントを変換：

```bash
# 現在のIPをリスト
fly ips list -a my-openclaw

# パブリックIPを解放
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# 今後のデプロイでパブリックIPが再割り当てされないようにプライベート設定に切り替え
# （[http_service]を削除するか、プライベートテンプレートでデプロイ）
fly deploy -c fly.private.toml

# プライベート専用IPv6を割り当て
fly ips allocate-v6 --private -a my-openclaw
```

この後、`fly ips list`には`private`タイプのIPのみが表示されるはずです：

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### プライベートデプロイメントへのアクセス

パブリックURLがないため、以下のいずれかの方法を使用してください：

**オプション1：ローカルプロキシ（最もシンプル）**

```bash
# ローカルポート3000をアプリに転送
fly proxy 3000:3000 -a my-openclaw

# その後ブラウザでhttp://localhost:3000を開く
```

**オプション2：WireGuard VPN**

```bash
# WireGuard設定を作成（1回のみ）
fly wireguard create

# WireGuardクライアントにインポートし、内部IPv6経由でアクセス
# 例：http://[fdaa:x:x:x:x::x]:3000
```

**オプション3：SSHのみ**

```bash
fly ssh console -a my-openclaw
```

### プライベートデプロイメントでのWebhook

パブリック公開なしでWebhookコールバック（Twilio、Telnyxなど）が必要な場合：

1. **ngrokトンネル** - コンテナ内またはサイドカーとしてngrokを実行
2. **Tailscale Funnel** - Tailscale経由で特定のパスを公開
3. **アウトバウンドのみ** - 一部のプロバイダー（Twilio）はWebhookなしでもアウトバウンド通話で正常に動作

ngrokを使用した音声通話設定の例：

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

ngrokトンネルはコンテナ内で実行され、Flyアプリ自体を公開することなくパブリックWebhook URLを提供します。転送されたホストヘッダーが受け入れられるよう、`webhookSecurity.allowedHosts`にパブリックトンネルホスト名を設定してください。

### セキュリティ上のメリット

| 項目            | パブリック       | プライベート    |
| ----------------- | ------------ | ---------- |
| インターネットスキャナー | 発見可能 | 非公開     |
| 直接攻撃    | 可能     | ブロック    |
| Control UIアクセス | ブラウザ      | プロキシ/VPN  |
| Webhook配信  | 直接       | トンネル経由 |

## 注意事項

- Fly.ioは**x86アーキテクチャ**を使用します（ARMではありません）
- Dockerfileは両方のアーキテクチャと互換性があります
- WhatsApp/Telegramのオンボーディングには`fly ssh console`を使用してください
- 永続データは`/data`のボリューム上にあります
- SignalにはJava + signal-cliが必要です。カスタムイメージを使用し、メモリを2GB+に維持してください。

## コスト

推奨設定（`shared-cpu-2x`、2GB RAM）の場合：

- 使用量に応じて月額約10-15ドル
- 無料枠にいくらかの余裕が含まれます

詳細は[Fly.io料金](https://fly.io/docs/about/pricing/)を参照してください。
