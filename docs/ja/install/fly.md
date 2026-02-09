---
title: Fly.io
description: Fly.io で OpenClaw をデプロイします
---

# Fly.io デプロイ

**目的:** 永続ストレージ、自動 HTTPS、Discord/チャンネル アクセスを備えた [Fly.io](https://fly.io) マシン上で OpenClaw Gateway（ゲートウェイ）を実行します。

## 必要なもの

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) がインストールされていること
- Fly.io アカウント（無料枠で可）
- モデル認証: Anthropic API キー（または他のプロバイダーのキー）
- チャンネル認証情報: Discord ボットトークン、Telegram トークン など

## 初心者向けクイック パス

1. リポジトリをクローン → `fly.toml` をカスタマイズ
2. アプリ + ボリュームを作成 → シークレットを設定
3. `fly deploy` でデプロイ
4. SSH で接続して設定を作成、または Control UI を使用

## 1) Fly アプリの作成

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**ヒント：** 近くの地域を選んでください。 一般的なオプション: `lhr` (ロンドン), `iad` (バージニア州), `sjc` (サンノゼ).

## 2. fly.toml の設定

アプリ名と要件に合わせて `fly.toml` を編集します。

**セキュリティノート:** デフォルトの設定は公開URLを公開します。 **セキュリティ注意:** デフォルト設定では公開 URL が公開されます。公開 IP を持たない堅牢化デプロイについては、[Private Deployment](#private-deployment-hardened) を参照するか、`fly.private.toml` を使用してください。

```toml
app = "my-openclaw"  # Your app name
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

**主要設定:**

| 設定                             | 理由                                                                |
| ------------------------------ | ----------------------------------------------------------------- |
| `--bind lan`                   | Fly のプロキシが ゲートウェイ に到達できるよう `0.0.0.0` にバインド                        |
| `--allow-unconfigured`         | 設定ファイルなしで起動（後で作成）                                                 |
| `internal_port = 3000`         | Fly のヘルスチェックのため `--port 3000`（または `OPENCLAW_GATEWAY_PORT`）と一致する必要 |
| `memory = "2048mb"`            | 512MB は小さすぎるため、2GB を推奨                                            |
| `OPENCLAW_STATE_DIR = "/data"` | ボリューム上に状態を永続化                                                     |

## 3. シークレットの設定

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**注記:**

- 非ループバック バインド（`--bind lan`）では、セキュリティのため `OPENCLAW_GATEWAY_TOKEN` が必要です。
- これらのトークンはパスワードと同様に扱ってください。
- \*\*すべての API キーとトークンに対して設定ファイルよりも env vars を優先します。 これにより、誤って公開されたりログに記録されたりすることのできる `openclaw.json` の秘密が保持されます。

## 4. デプロイ

```bash
fly deploy
```

初回デプロイでは Docker イメージをビルドします（約 2～3 分）。以降のデプロイは高速です。 その後のデプロイが速くなります。

デプロイ後、次を確認します。

```bash
fly status
fly logs
```

表示する必要があります:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. 設定ファイルの作成

SSH でマシンに接続し、適切な設定を作成します。

```bash
fly ssh console
```

設定ディレクトリとファイルを作成します。

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

**注記:** `OPENCLAW_STATE_DIR=/data` を使用している場合、設定パスは `/data/openclaw.json` です。

**注記:** Discord トークンは次のいずれかから取得できます。

- 環境変数: `DISCORD_BOT_TOKEN`（シークレットには推奨）
- 設定ファイル: `channels.discord.token`

env var を使用する場合は、config にトークンを追加する必要はありません。 ゲートウェイは `DISCORD_BOT_TOKEN` を自動的に読み込みます。

適用するため再起動します。

```bash
exit
fly machine restart <machine-id>
```

## 6. Gateway（ゲートウェイ）へのアクセス

### Control UI

ブラウザーで開きます。

```bash
fly open
```

または `https://my-openclaw.fly.dev/` にアクセスします。

`OPENCLAW_GATEWAY_TOKEN` から取得した ゲートウェイ トークンを貼り付けて認証します。

### ログ

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH コンソール

```bash
fly ssh console
```

## トラブルシューティング

### 「App is not listening on expected address」

ゲートウェイ が `0.0.0.0` ではなく `127.0.0.1` にバインドしています。

**対処:** `fly.toml` のプロセス コマンドに `--bind lan` を追加してください。

### ヘルスチェック失敗 / connection refused

設定されたポートで Fly が ゲートウェイ に到達できません。

**対処:** `internal_port` が ゲートウェイ のポートと一致していることを確認してください（`--port 3000` または `OPENCLAW_GATEWAY_PORT=3000` を設定）。

### OOM / メモリ問題

コンテナは再起動または殺され続けます。 コンテナが再起動を繰り返す、または強制終了されます。兆候: `SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration`、または無言の再起動。

**対処:** `fly.toml` のメモリを増やします。

```toml
[[vm]]
  memory = "2048mb"
```

または既存のマシンを更新します。

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意：** 512MBが小さすぎます。 1GBは動作するかもしれませんが、負荷下または冗長ロギングでOOMすることができます。 **2GB を推奨します。**

### Gateway ロックの問題

「already running」エラーで Gateway（ゲートウェイ）が起動しません。

これは、コンテナが再起動しても PID ロック ファイルがボリュームに残る場合に発生します。

**対処:** ロック ファイルを削除します。

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

ロック ファイルは `/data/gateway.*.lock`（サブディレクトリではありません）にあります。

### 設定が読み込まれない

`--allow-unconfigured` を使用する場合、ゲートウェイは最小限の設定を作成します。 `--allow-unconfigured` を使用している場合、ゲートウェイ は最小限の設定を作成します。再起動時に `/data/openclaw.json` のカスタム設定が読み込まれるはずです。

設定の存在を確認します。

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH 経由での設定書き込み

`fly ssh console -C` コマンドはシェルのリダイレクトをサポートしていません。設定ファイルを書き込むには次を使用します。 設定ファイルを書き込む:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**注記:** ファイルが既に存在する場合、`fly sftp` は失敗することがあります。先に削除してください。 最初に削除:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 状態が永続化されない

再起動後に認証情報やセッションが失われる場合、状態ディレクトリがコンテナのファイルシステムに書き込まれています。

**対処:** `fly.toml` に `OPENCLAW_STATE_DIR=/data` が設定されていることを確認し、再デプロイしてください。

## 更新

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### マシン コマンドの更新

完全な再デプロイなしで起動コマンドを変更する必要がある場合:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注記:** `fly deploy` の後、マシン コマンドは `fly.toml` に記載の内容へリセットされる場合があります。手動変更を行った場合は、デプロイ後に再適用してください。 手動で変更を加えた場合は、デプロイ後に再度適用します。

## Private Deployment（堅牢化）

デフォルトでは、Fly は公開 IP を割り当て、ゲートウェイ は `https://your-app.fly.dev` でアクセス可能になります。便利ですが、インターネット スキャナー（Shodan、Censys など）に発見される可能性があります。 これは便利ですが、インターネットスキャナー(Shodan、Censysなど)で展開を確認できることを意味します。

**公開なし**の堅牢化デプロイには、プライベート テンプレートを使用してください。

### プライベート デプロイを使用する場合

- **アウトバウンド** の呼び出し/メッセージのみを行う（インバウンド Webhook なし）
- Webhook コールバックに **ngrok または Tailscale** トンネルを使用
- ブラウザーではなく **SSH、プロキシ、または WireGuard** 経由で ゲートウェイ にアクセス
- デプロイを **インターネット スキャナーから隠したい**

### セットアップ

標準設定の代わりに `fly.private.toml` を使用します。

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

または既存のデプロイを変換します。

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

この後、`fly ips list` には `private` タイプの IP のみが表示されるはずです。

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### プライベート デプロイへのアクセス

公開 URL がないため、次のいずれかを使用します。

**オプション 1: ローカル プロキシ（最も簡単）**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**オプション 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**オプション 3: SSH のみ**

```bash
fly ssh console -a my-openclaw
```

### プライベート デプロイでの Webhook

公開なしで Webhook コールバック（Twilio、Telnyx など）が必要な場合: 公開されることなく

1. **ngrok トンネル** - コンテナ内またはサイドカーとして ngrok を実行
2. **Tailscale Funnel** - Tailscale 経由で特定パスを公開
3. **アウトバウンドのみ** - 一部プロバイダー（Twilio）は Webhook なしでもアウトバウンドで問題なく動作

ngrok を使用した音声通話設定の例:

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

ngrok トンネルはコンテナ内で実行され、Fly アプリ自体を公開せずに公開 Webhook URL を提供します。転送される Host ヘッダーを受け入れるため、`webhookSecurity.allowedHosts` を公開トンネルのホスト名に設定してください。 `webhookSecurity.allowedHosts`をパブリックトンネルホスト名に設定すると、転送されたホストヘッダが受け入れられます。

### セキュリティ上の利点

| 観点              | Public | Private  |
| --------------- | ------ | -------- |
| インターネット スキャナー   | 検出可能   | 非公開      |
| 直接攻撃            | 可能     | ブロック     |
| Control UI アクセス | ブラウザー  | プロキシ/VPN |
| Webhook 配信      | 直接     | トンネル経由   |

## 注記

- Fly.io は **x86 アーキテクチャ** を使用（ARM ではありません）
- Dockerfile は両方のアーキテクチャに対応しています
- WhatsApp/Telegram のオンボーディングには `fly ssh console` を使用してください
- 永続データは `/data` のボリュームに保存されます
- Signal には Java + signal-cli が必要です。カスタム イメージを使用し、メモリは 2GB 以上を維持してください。

## コスト

推奨設定（`shared-cpu-2x`、2GB RAM）では:

- 使用状況により月額 約 $10～15
- 無料枠には一定の割当が含まれます

詳細は [Fly.io pricing](https://fly.io/docs/about/pricing/) を参照してください。
