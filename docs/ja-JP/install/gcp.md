---
read_when:
    - GCP上でOpenClawを24時間365日稼働させたい
    - 自分のVM上で本番グレードの常時稼働Gateway ゲートウェイを構築したい
    - 永続化、バイナリ、再起動の挙動を完全に制御したい
summary: GCP Compute Engine VM（Docker）上で永続的な状態を持つ OpenClaw Gateway ゲートウェイを24時間365日稼働させる
title: GCP
x-i18n:
    generated_at: "2026-04-02T08:33:16Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: ee00ea1bc1ea36efa000d88cbbdbe46e9b87b354613604f5b8f30e205b3d13c9
    source_path: install/gcp.md
    workflow: 15
---

# GCP Compute Engine上のOpenClaw（Docker、本番VPSガイド）

## 目標

Dockerを使用してGCP Compute Engine VM上で永続的なOpenClaw Gateway ゲートウェイを稼働させます。永続的な状態、組み込みバイナリ、安全な再起動の挙動を備えます。

「月額約$5〜12でOpenClawを24時間365日稼働」させたい場合、これはGoogle Cloud上の信頼性の高いセットアップです。
料金はマシンタイプとリージョンによって異なります。ワークロードに適した最小のVMを選び、OOMが発生した場合はスケールアップしてください。

## 何をするのか（簡単に言うと）

- GCPプロジェクトを作成し、課金を有効にする
- Compute Engine VMを作成する
- Docker（隔離されたアプリランタイム）をインストールする
- DockerでOpenClaw Gateway ゲートウェイを起動する
- `~/.openclaw` + `~/.openclaw/workspace` をホストに永続化する（再起動やリビルドに耐える）
- SSHトンネル経由でラップトップからコントロールUIにアクセスする

Gateway ゲートウェイには以下の方法でアクセスできます：

- ラップトップからのSSHポートフォワーディング
- ファイアウォールとトークンを自分で管理する場合は直接ポート公開

このガイドではGCP Compute Engine上のDebianを使用します。
Ubuntuでも動作します。パッケージを適宜読み替えてください。
汎用的なDockerフローについては、[Docker](/install/docker)を参照してください。

---

## クイックパス（経験者向け）

1. GCPプロジェクトを作成 + Compute Engine APIを有効化
2. Compute Engine VMを作成（e2-small、Debian 12、20GB）
3. VMにSSH接続
4. Dockerをインストール
5. OpenClawリポジトリをクローン
6. 永続的なホストディレクトリを作成
7. `.env` と `docker-compose.yml` を設定
8. 必要なバイナリのベイク、ビルド、起動

---

## 必要なもの

- GCPアカウント（e2-microは無料枠の対象）
- gcloud CLIのインストール（またはCloud Consoleを使用）
- ラップトップからのSSHアクセス
- SSH + コピー＆ペーストの基本的な操作に慣れていること
- 約20〜30分
- DockerとDocker Compose
- モデル認証情報
- オプションのプロバイダー認証情報
  - WhatsApp QR
  - Telegramボットトークン
  - Gmail OAuth

---

<Steps>
  <Step title="gcloud CLIのインストール（またはConsoleを使用）">
    **オプションA: gcloud CLI**（自動化におすすめ）

    [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) からインストールしてください

    初期化と認証：

    ```bash
    gcloud init
    gcloud auth login
    ```

    **オプションB: Cloud Console**

    すべての手順は [https://console.cloud.google.com](https://console.cloud.google.com) のWeb UIから実行できます

  </Step>

  <Step title="GCPプロジェクトの作成">
    **CLI：**

    ```bash
    gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
    gcloud config set project my-openclaw-project
    ```

    [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) で課金を有効にしてください（Compute Engineに必要です）。

    Compute Engine APIを有効化：

    ```bash
    gcloud services enable compute.googleapis.com
    ```

    **Console：**

    1. IAMと管理 > プロジェクトの作成に移動
    2. 名前を付けて作成
    3. プロジェクトの課金を有効化
    4. APIとサービス > APIの有効化 > 「Compute Engine API」を検索 > 有効化

  </Step>

  <Step title="VMの作成">
    **マシンタイプ：**

    | タイプ    | スペック                    | コスト              | 備考                                         |
    | --------- | ------------------------ | ------------------- | -------------------------------------------- |
    | e2-medium | 2 vCPU、4GB RAM          | 約$25/月            | ローカルDockerビルドに最も安定                |
    | e2-small  | 2 vCPU、2GB RAM          | 約$12/月            | Dockerビルドの最低推奨                        |
    | e2-micro  | 2 vCPU（共有）、1GB RAM   | 無料枠対象          | DockerビルドのOOM（exit 137）で失敗することが多い |

    **CLI：**

    ```bash
    gcloud compute instances create openclaw-gateway \
      --zone=us-central1-a \
      --machine-type=e2-small \
      --boot-disk-size=20GB \
      --image-family=debian-12 \
      --image-project=debian-cloud
    ```

    **Console：**

    1. Compute Engine > VMインスタンス > インスタンスを作成に移動
    2. 名前：`openclaw-gateway`
    3. リージョン：`us-central1`、ゾーン：`us-central1-a`
    4. マシンタイプ：`e2-small`
    5. ブートディスク：Debian 12、20GB
    6. 作成

  </Step>

  <Step title="VMにSSH接続">
    **CLI：**

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    **Console：**

    Compute EngineダッシュボードでVMの横にある「SSH」ボタンをクリックしてください。

    注意：VM作成後、SSHキーの伝播に1〜2分かかることがあります。接続が拒否された場合は、少し待ってから再試行してください。

  </Step>

  <Step title="Docker のインストール（VM上）">
    ```bash
    sudo apt-get update
    sudo apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    ```

    グループの変更を反映するため、ログアウトして再度ログインしてください：

    ```bash
    exit
    ```

    その後、再度SSH接続：

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    確認：

    ```bash
    docker --version
    docker compose version
    ```

  </Step>

  <Step title="OpenClawリポジトリのクローン">
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    ```

    このガイドでは、バイナリの永続性を保証するためにカスタムイメージをビルドすることを前提としています。

  </Step>

  <Step title="永続的なホストディレクトリの作成">
    Dockerコンテナは一時的なものです。
    長期的な状態はすべてホストに保存する必要があります。

    ```bash
    mkdir -p ~/.openclaw
    mkdir -p ~/.openclaw/workspace
    ```

  </Step>

  <Step title="環境変数の設定">
    リポジトリのルートに `.env` を作成してください。

    ```bash
    OPENCLAW_IMAGE=openclaw:latest
    OPENCLAW_GATEWAY_TOKEN=change-me-now
    OPENCLAW_GATEWAY_BIND=lan
    OPENCLAW_GATEWAY_PORT=18789

    OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
    OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

    GOG_KEYRING_PASSWORD=change-me-now
    XDG_CONFIG_HOME=/home/node/.openclaw
    ```

    強力なシークレットを生成：

    ```bash
    openssl rand -hex 32
    ```

    **このファイルはコミットしないでください。**

  </Step>

  <Step title="Docker Composeの設定">
    `docker-compose.yml` を作成または更新してください。

    ```yaml
    services:
      openclaw-gateway:
        image: ${OPENCLAW_IMAGE}
        build: .
        restart: unless-stopped
        env_file:
          - .env
        environment:
          - HOME=/home/node
          - NODE_ENV=production
          - TERM=xterm-256color
          - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
          - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
          - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
          - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
          - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
          - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
        volumes:
          - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
          - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
        ports:
          # 推奨：GatewayはVM上でloopbackのみにし、SSHトンネル経由でアクセスしてください。
          # 公開する場合は `127.0.0.1:` プレフィックスを削除し、適切にファイアウォールを設定してください。
          - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
        command:
          [
            "node",
            "dist/index.js",
            "gateway",
            "--bind",
            "${OPENCLAW_GATEWAY_BIND}",
            "--port",
            "${OPENCLAW_GATEWAY_PORT}",
            "--allow-unconfigured",
          ]
    ```

    `--allow-unconfigured` はブートストラップの利便性のためだけのものであり、適切なGateway ゲートウェイ設定の代わりにはなりません。認証（`gateway.auth.token` またはパスワード）を設定し、デプロイメントに適した安全なバインド設定を使用してください。

  </Step>

  <Step title="共有Docker VMランタイム手順">
    共通のDockerホストフローについては、共有ランタイムガイドを使用してください：

    - [必要なバイナリをイメージにベイクする](/install/docker-vm-runtime#bake-required-binaries-into-the-image)
    - [ビルドと起動](/install/docker-vm-runtime#build-and-launch)
    - [永続化の場所](/install/docker-vm-runtime#what-persists-where)
    - [アップデート](/install/docker-vm-runtime#updates)

  </Step>

  <Step title="GCP固有の起動に関する注意事項">
    GCPでは、`pnpm install --frozen-lockfile` 中に `Killed` または `exit code 137` でビルドが失敗した場合、VMのメモリが不足しています。最低 `e2-small` を使用するか、最初のビルドをより確実に行うには `e2-medium` を使用してください。

    LAN にバインドする場合（`OPENCLAW_GATEWAY_BIND=lan`）、続行する前に信頼済みブラウザオリジンを設定してください：

    ```bash
    docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
    ```

    Gateway ゲートウェイのポートを変更した場合は、`18789` を設定したポートに置き換えてください。

  </Step>

  <Step title="ラップトップからのアクセス">
    Gateway ゲートウェイのポートを転送するSSHトンネルを作成します：

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
    ```

    ブラウザで開きます：

    `http://127.0.0.1:18789/`

    トークン付きダッシュボードリンクを新たに取得：

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

    そのURLからトークンを貼り付けてください。

    コントロールUIに `unauthorized` または `disconnected (1008): pairing required` が表示される場合は、ブラウザデバイスを承認してください：

    ```bash
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    永続化とアップデートのリファレンスが再度必要ですか？
    [Docker VMランタイム](/install/docker-vm-runtime#what-persists-where) および [Docker VMランタイムのアップデート](/install/docker-vm-runtime#updates) を参照してください。

  </Step>
</Steps>

---

## トラブルシューティング

**SSH接続が拒否される**

VM作成後、SSHキーの伝播に1〜2分かかることがあります。少し待ってから再試行してください。

**OS Loginの問題**

OS Loginプロファイルを確認してください：

```bash
gcloud compute os-login describe-profile
```

アカウントに必要なIAM権限（Compute OS LoginまたはCompute OS Admin Login）があることを確認してください。

**メモリ不足（OOM）**

Dockerビルドが `Killed` と `exit code 137` で失敗した場合、VMがOOMキルされました。e2-small（最低）またはe2-medium（ローカルビルドに推奨）にアップグレードしてください：

```bash
# まずVMを停止
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# マシンタイプを変更
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# VMを起動
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## サービスアカウント（セキュリティのベストプラクティス）

個人利用の場合、デフォルトのユーザーアカウントで問題ありません。

自動化やCI/CDパイプラインの場合は、最小限の権限を持つ専用のサービスアカウントを作成してください：

1. サービスアカウントを作成：

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Admin ロール（またはより狭いカスタムロール）を付与：

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

自動化にOwnerロールを使用しないでください。最小権限の原則を使用してください。

IAMロールの詳細は [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) を参照してください。

---

## 次のステップ

- メッセージングチャネルのセットアップ：[チャネル](/channels)
- ローカルデバイスをノードとしてペアリング：[ノード](/nodes)
- Gateway ゲートウェイの設定：[Gateway ゲートウェイ設定](/gateway/configuration)
