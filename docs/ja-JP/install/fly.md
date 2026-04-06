---
read_when:
    - OpenClawをFly.ioにデプロイする
    - Flyボリューム、シークレット、初回設定のセットアップ
summary: 永続ストレージとHTTPSを使用したOpenClawのFly.ioデプロイ手順
title: Fly.io
x-i18n:
    generated_at: "2026-04-02T08:33:36Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 930dd58369116ffb893d5b74ad5ec95dd9e3a60adea87f9f1f4ed5a3d1551cb6
    source_path: install/fly.md
    workflow: 15
---

# Fly.ioデプロイ

**目標:** [Fly.io](https://fly.io)マシン上で、永続ストレージ、自動HTTPS、Discord/チャネルアクセスを備えたOpenClaw Gateway ゲートウェイを実行する。

## 必要なもの

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)がインストール済みであること
- Fly.ioアカウント（無料枠で利用可能）
- モデル認証: 選択したモデルプロバイダーのAPIキー
- チャネル認証情報: Discordボットトークン、Telegramトークンなど

## 初心者向けクイックパス

1. リポジトリをクローン → `fly.toml`をカスタマイズ
2. アプリ + ボリュームを作成 → シークレットを設定
3. `fly deploy`でデプロイ
4. SSHで接続して設定を作成するか、Control UIを使用

<Steps>
  <Step title="Flyアプリを作成する">
    ```bash
    # リポジトリをクローン
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw

    # 新しいFlyアプリを作成（任意の名前を指定）
    fly apps create my-openclaw

    # 永続ボリュームを作成（1GBで通常は十分）
    fly volumes create openclaw_data --size 1 --region iad
    ```

    **ヒント:** 自分に近いリージョンを選択してください。一般的な選択肢: `lhr`（ロンドン）、`iad`（バージニア）、`sjc`（サンノゼ）。

  </Step>

  <Step title="fly.tomlを設定する">
    `fly.toml`を編集して、アプリ名と要件に合わせます。

    **セキュリティに関する注意:** デフォルト設定ではパブリックURLが公開されます。パブリックIPなしの強化デプロイについては、[プライベートデプロイ](#private-deployment-hardened)を参照するか、`fly.private.toml`を使用してください。

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

    **主要な設定:**

    | 設定                           | 理由                                                                        |
    | ------------------------------ | --------------------------------------------------------------------------- |
    | `--bind lan`                   | `0.0.0.0`にバインドし、FlyプロキシがGateway ゲートウェイに到達できるようにする |
    | `--allow-unconfigured`         | 設定ファイルなしで起動する（後で作成します）                                    |
    | `internal_port = 3000`         | Flyのヘルスチェックのため`--port 3000`（または`OPENCLAW_GATEWAY_PORT`）と一致させる必要がある |
    | `memory = "2048mb"`            | 512MBでは不十分。2GB推奨                                                     |
    | `OPENCLAW_STATE_DIR = "/data"` | ボリューム上に状態を永続化する                                                |

  </Step>

  <Step title="シークレットを設定する">
    ```bash
    # 必須: Gatewayトークン（非ループバックバインド用）
    fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

    # モデルプロバイダーのAPIキー
    fly secrets set ANTHROPIC_API_KEY=sk-ant-...

    # オプション: その他のプロバイダー
    fly secrets set OPENAI_API_KEY=sk-...
    fly secrets set GOOGLE_API_KEY=...

    # チャネルトークン
    fly secrets set DISCORD_BOT_TOKEN=MTQ...
    ```

    **注意事項:**

    - 非ループバックバインド（`--bind lan`）では、セキュリティのために`OPENCLAW_GATEWAY_TOKEN`が必要です。
    - これらのトークンはパスワードと同様に扱ってください。
    - **すべてのAPIキーとトークンには、設定ファイルよりも環境変数を推奨します。** これにより、シークレットが`openclaw.json`に含まれず、誤って公開またはログに記録されることを防げます。

  </Step>

  <Step title="デプロイする">
    ```bash
    fly deploy
    ```

    初回デプロイではDockerイメージのビルドに約2〜3分かかります。以降のデプロイはより高速です。

    デプロイ後、確認します:

    ```bash
    fly status
    fly logs
    ```

    以下のように表示されるはずです:

    ```
    [gateway] listening on ws://0.0.0.0:3000 (PID xxx)
    [discord] logged in to discord as xxx
    ```

  </Step>

  <Step title="設定ファイルを作成する">
    マシンにSSHで接続して適切な設定を作成します:

    ```bash
    fly ssh console
    ```

    設定ディレクトリとファイルを作成します:

    ```bash
    mkdir -p /data
    cat > /data/openclaw.json << 'EOF'
    {
      "agents": {
        "defaults": {
          "model": {
            "primary": "anthropic/claude-opus-4-6",
            "fallbacks": ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"]
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
      "meta": {}
    }
    EOF
    ```

    **注意:** `OPENCLAW_STATE_DIR=/data`を設定している場合、設定ファイルのパスは`/data/openclaw.json`になります。

    **注意:** Discordトークンは以下のいずれかから取得できます:

    - 環境変数: `DISCORD_BOT_TOKEN`（シークレットにはこちらを推奨）
    - 設定ファイル: `channels.discord.token`

    環境変数を使用する場合、設定にトークンを追加する必要はありません。Gateway ゲートウェイは`DISCORD_BOT_TOKEN`を自動的に読み取ります。

    再起動して適用します:

    ```bash
    exit
    fly machine restart <machine-id>
    ```

  </Step>

  <Step title="Gatewayにアクセスする">
    ### Control UI

    ブラウザで開きます:

    ```bash
    fly open
    ```

    または`https://my-openclaw.fly.dev/`にアクセスします。

    Gateway ゲートウェイトークン（`OPENCLAW_GATEWAY_TOKEN`で設定したもの）を貼り付けて認証します。

    ### ログ

    ```bash
    fly logs              # ライブログ
    fly logs --no-tail    # 最近のログ
    ```

    ### SSHコンソール

    ```bash
    fly ssh console
    ```

  </Step>
</Steps>

## トラブルシューティング

### 「App is not listening on expected address」

Gateway ゲートウェイが`0.0.0.0`ではなく`127.0.0.1`にバインドしています。

**修正方法:** `fly.toml`のプロセスコマンドに`--bind lan`を追加してください。

### ヘルスチェックの失敗 / 接続拒否

Flyが設定されたポートでGateway ゲートウェイに到達できません。

**修正方法:** `internal_port`がGateway ゲートウェイのポートと一致していることを確認してください（`--port 3000`または`OPENCLAW_GATEWAY_PORT=3000`を設定）。

### OOM / メモリの問題

コンテナが再起動を繰り返すか、強制終了されます。兆候: `SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration`、またはサイレントな再起動。

**修正方法:** `fly.toml`のメモリを増やしてください:

```toml
[[vm]]
  memory = "2048mb"
```

または既存のマシンを更新します:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意:** 512MBでは不十分です。1GBでも動作する場合がありますが、高負荷時や詳細ログ出力時にOOMが発生する可能性があります。**2GBを推奨します。**

### Gatewayロックの問題

Gateway ゲートウェイが「already running」エラーで起動を拒否します。

これはコンテナが再起動したにもかかわらず、PIDロックファイルがボリューム上に残っている場合に発生します。

**修正方法:** ロックファイルを削除してください:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

ロックファイルは`/data/gateway.*.lock`にあります（サブディレクトリ内ではありません）。

### 設定が読み込まれない

`--allow-unconfigured`を使用している場合、Gateway ゲートウェイは最小限の設定を作成します。`/data/openclaw.json`のカスタム設定は再起動時に読み込まれるはずです。

設定が存在することを確認します:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH経由で設定を書き込む

`fly ssh console -C`コマンドはシェルリダイレクトをサポートしていません。設定ファイルを書き込むには:

```bash
# echo + teeを使用（ローカルからリモートへパイプ）
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# またはsftpを使用
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**注意:** ファイルが既に存在する場合、`fly sftp`は失敗することがあります。先に削除してください:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 状態が永続化されない

再起動後に認証情報やセッションが失われる場合、状態ディレクトリがコンテナのファイルシステムに書き込まれています。

**修正方法:** `fly.toml`で`OPENCLAW_STATE_DIR=/data`が設定されていることを確認し、再デプロイしてください。

## 更新

```bash
# 最新の変更を取得
git pull

# 再デプロイ
fly deploy

# 正常性を確認
fly status
fly logs
```

### マシンコマンドの更新

完全な再デプロイなしで起動コマンドを変更する必要がある場合:

```bash
# マシンIDを取得
fly machines list

# コマンドを更新
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# またはメモリ増加と合わせて
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注意:** `fly deploy`後、マシンコマンドは`fly.toml`の内容にリセットされる場合があります。手動で変更した場合は、デプロイ後に再適用してください。

## プライベートデプロイ（強化版）

デフォルトでは、FlyはパブリックIPを割り当て、Gateway ゲートウェイが`https://your-app.fly.dev`でアクセス可能になります。これは便利ですが、インターネットスキャナー（Shodan、Censysなど）からデプロイが検出可能になることを意味します。

**パブリック公開なし**の強化デプロイには、プライベートテンプレートを使用してください。

### プライベートデプロイを使用する場合

- **アウトバウンド**のみの通話/メッセージを行う場合（インバウンドWebhookなし）
- Webhookコールバックに**ngrokまたはTailscale**トンネルを使用する場合
- ブラウザの代わりに**SSH、プロキシ、またはWireGuard**でGateway ゲートウェイにアクセスする場合
- デプロイを**インターネットスキャナーから隠したい**場合

### セットアップ

標準の設定の代わりに`fly.private.toml`を使用します:

```bash
# プライベート設定でデプロイ
fly deploy -c fly.private.toml
```

または既存のデプロイを変換します:

```bash
# 現在のIPを一覧表示
fly ips list -a my-openclaw

# パブリックIPを解放
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# プライベート設定に切り替え（今後のデプロイでパブリックIPが再割り当てされないようにする）
# （[http_service]を削除するか、プライベートテンプレートでデプロイ）
fly deploy -c fly.private.toml

# プライベート専用IPv6を割り当て
fly ips allocate-v6 --private -a my-openclaw
```

この後、`fly ips list`には`private`タイプのIPのみが表示されるはずです:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### プライベートデプロイへのアクセス

パブリックURLがないため、以下のいずれかの方法を使用します:

**方法1: ローカルプロキシ（最も簡単）**

```bash
# ローカルポート3000をアプリに転送
fly proxy 3000:3000 -a my-openclaw

# その後ブラウザでhttp://localhost:3000を開く
```

**方法2: WireGuard VPN**

```bash
# WireGuard設定を作成（初回のみ）
fly wireguard create

# WireGuardクライアントにインポートし、内部IPv6でアクセス
# 例: http://[fdaa:x:x:x:x::x]:3000
```

**方法3: SSHのみ**

```bash
fly ssh console -a my-openclaw
```

### プライベートデプロイでのWebhook

パブリック公開なしでWebhookコールバック（Twilio、Telnyxなど）が必要な場合:

1. **ngrokトンネル** - コンテナ内またはサイドカーとしてngrokを実行
2. **Tailscale Funnel** - Tailscale経由で特定のパスを公開
3. **アウトバウンドのみ** - 一部のプロバイダー（Twilio）はWebhookなしでアウトバウンド通話が正常に動作

ngrokを使用したボイスコール設定の例:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          tunnel: { provider: "ngrok" },
          webhookSecurity: {
            allowedHosts: ["example.ngrok.app"],
          },
        },
      },
    },
  },
}
```

ngrokトンネルはコンテナ内で実行され、Flyアプリ自体を公開することなくパブリックなWebhook URLを提供します。転送されたホストヘッダーが受け入れられるよう、`webhookSecurity.allowedHosts`にパブリックトンネルのホスト名を設定してください。

### セキュリティ上の利点

| 観点               | パブリック    | プライベート |
| ------------------ | ------------ | ---------- |
| インターネットスキャナー | 検出可能     | 隠蔽       |
| 直接攻撃           | 可能         | ブロック   |
| Control UIアクセス  | ブラウザ     | プロキシ/VPN |
| Webhook配信        | 直接         | トンネル経由 |

## 注意事項

- Fly.ioは**x86アーキテクチャ**を使用しています（ARMではありません）
- Dockerfileはどちらのアーキテクチャとも互換性があります
- WhatsApp/Telegramのオンボーディングには、`fly ssh console`を使用してください
- 永続データはボリュームの`/data`に保存されます
- SignalにはJava + signal-cliが必要です。カスタムイメージを使用し、メモリは2GB以上を確保してください。

## コスト

推奨構成（`shared-cpu-2x`、2GB RAM）の場合:

- 使用量に応じて月額約$10〜15
- 無料枠にはある程度の割り当てが含まれます

詳細は[Fly.ioの料金](https://fly.io/docs/about/pricing/)を参照してください。

## 次のステップ

- メッセージングチャネルのセットアップ: [チャネル](/channels)
- Gateway ゲートウェイの設定: [Gateway ゲートウェイ設定](/gateway/configuration)
- OpenClawを最新の状態に保つ: [更新](/install/updating)
