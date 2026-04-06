---
read_when:
    - OpenClawをノートパソコンではなくクラウドVPSで24時間365日稼働させたい場合
    - 自分のVPS上で本番グレードの常時稼働Gateway ゲートウェイを構築したい場合
    - 永続性、バイナリ、再起動時の動作を完全に制御したい場合
    - Hetznerまたは類似のプロバイダーでOpenClawをDockerで実行している場合
summary: 安価なHetzner VPS（Docker）上でOpenClaw Gateway ゲートウェイを24時間365日稼働させ、永続的な状態と組み込みバイナリを実現する
title: Hetzner
x-i18n:
    generated_at: "2026-04-02T08:32:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 615a604d0438637b9ef41129bed6f187e3ce6578675ecf3e497ad227e65d2a11
    source_path: install/hetzner.md
    workflow: 15
---

# OpenClaw on Hetzner（Docker、本番VPSガイド）

## 目標

Hetzner VPS上でDockerを使用し、永続的な状態、組み込みバイナリ、安全な再起動動作を備えた永続的なOpenClaw Gateway ゲートウェイを実行します。

「OpenClawを月額約5ドルで24時間365日稼働」させたい場合、これが最もシンプルで信頼性の高いセットアップです。
Hetznerの料金は変更される場合があります。最小のDebian/Ubuntu VPSを選択し、OOMが発生した場合はスケールアップしてください。

セキュリティモデルに関する注意:

- 全員が同じ信頼境界内にあり、ランタイムがビジネス用途のみである場合、会社共有のエージェントは問題ありません。
- 厳格な分離を維持してください：専用のVPS/ランタイム＋専用のアカウント。そのホストに個人のApple/Google/ブラウザ/パスワードマネージャーのプロファイルを置かないでください。
- ユーザー同士が敵対的な場合は、Gateway ゲートウェイ/ホスト/OSユーザーごとに分離してください。

[セキュリティ](/gateway/security)および[VPSホスティング](/vps)を参照してください。

## 何をするのか（簡単に説明）

- 小さなLinuxサーバー（Hetzner VPS）をレンタルする
- Docker（隔離されたアプリランタイム）をインストールする
- OpenClaw Gateway ゲートウェイをDockerで起動する
- `~/.openclaw` + `~/.openclaw/workspace` をホスト上に永続化する（再起動/リビルドに耐える）
- SSHトンネル経由でノートパソコンからコントロールUIにアクセスする

Gateway ゲートウェイへのアクセス方法:

- ノートパソコンからのSSHポートフォワーディング
- ファイアウォールとトークンを自分で管理する場合はポートの直接公開

このガイドはHetzner上のUbuntuまたはDebianを前提としています。
別のLinux VPSを使用している場合は、パッケージを適宜読み替えてください。
一般的なDockerフローについては、[Docker](/install/docker)を参照してください。

---

## クイックパス（経験豊富なオペレーター向け）

1. Hetzner VPSをプロビジョニング
2. Dockerをインストール
3. OpenClawリポジトリをクローン
4. 永続的なホストディレクトリを作成
5. `.env` と `docker-compose.yml` を設定
6. 必要なバイナリをイメージに組み込み
7. `docker compose up -d`
8. 永続性とGateway ゲートウェイへのアクセスを確認

---

## 必要なもの

- root アクセス可能なHetzner VPS
- ノートパソコンからのSSHアクセス
- SSH＋コピー&ペーストの基本的な操作に慣れていること
- 約20分
- DockerおよびDocker Compose
- モデル認証情報
- オプションのプロバイダー認証情報
  - WhatsApp QRコード
  - Telegramボットトークン
  - Gmail OAuth

---

<Steps>
  <Step title="VPSのプロビジョニング">
    HetznerでUbuntuまたはDebianのVPSを作成します。

    rootとして接続:

    ```bash
    ssh root@YOUR_VPS_IP
    ```

    このガイドではVPSがステートフルであることを前提としています。
    使い捨てのインフラとして扱わないでください。

  </Step>

  <Step title="Dockerのインストール（VPS上）">
    ```bash
    apt-get update
    apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sh
    ```

    確認:

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
    Dockerコンテナはエフェメラル（一時的）です。
    長期間保持するすべての状態はホスト上に配置する必要があります。

    ```bash
    mkdir -p /root/.openclaw/workspace

    # Set ownership to the container user (uid 1000):
    chown -R 1000:1000 /root/.openclaw
    ```

  </Step>

  <Step title="環境変数の設定">
    リポジトリルートに `.env` を作成します。

    ```bash
    OPENCLAW_IMAGE=openclaw:latest
    OPENCLAW_GATEWAY_TOKEN=change-me-now
    OPENCLAW_GATEWAY_BIND=lan
    OPENCLAW_GATEWAY_PORT=18789

    OPENCLAW_CONFIG_DIR=/root/.openclaw
    OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

    GOG_KEYRING_PASSWORD=change-me-now
    XDG_CONFIG_HOME=/home/node/.openclaw
    ```

    強力なシークレットを生成:

    ```bash
    openssl rand -hex 32
    ```

    **このファイルをコミットしないでください。**

  </Step>

  <Step title="Docker Compose設定">
    `docker-compose.yml` を作成または更新します。

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
          # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
          # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
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

    `--allow-unconfigured` はブートストラップの利便性のためだけのもので、適切なGateway ゲートウェイ設定の代替にはなりません。認証（`gateway.auth.token` またはパスワード）を設定し、デプロイに適した安全なバインド設定を使用してください。

  </Step>

  <Step title="共有Docker VMランタイム手順">
    共通のDockerホストフローについては、共有ランタイムガイドを使用してください:

    - [必要なバイナリをイメージに組み込み](/install/docker-vm-runtime#bake-required-binaries-into-the-image)
    - [ビルドと起動](/install/docker-vm-runtime#build-and-launch)
    - [どこに何が永続化されるか](/install/docker-vm-runtime#what-persists-where)
    - [更新](/install/docker-vm-runtime#updates)

  </Step>

  <Step title="Hetzner固有のアクセス">
    共有のビルドと起動手順の後、ノートパソコンからトンネルを作成します:

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
    ```

    以下を開きます:

    `http://127.0.0.1:18789/`

    Gateway ゲートウェイトークンを貼り付けます。

  </Step>
</Steps>

共有の永続化マップは[Docker VMランタイム](/install/docker-vm-runtime#what-persists-where)にあります。

## Infrastructure as Code（Terraform）

Infrastructure as Codeワークフローを好むチーム向けに、コミュニティメンテナンスのTerraformセットアップが以下を提供します:

- リモートステート管理を備えたモジュラーなTerraform設定
- cloud-initによる自動プロビジョニング
- デプロイスクリプト（ブートストラップ、デプロイ、バックアップ/リストア）
- セキュリティ強化（ファイアウォール、UFW、SSHのみのアクセス）
- Gateway ゲートウェイアクセス用のSSHトンネル設定

**リポジトリ:**

- インフラストラクチャ: [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker設定: [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

このアプローチは、再現可能なデプロイ、バージョン管理されたインフラストラクチャ、および自動化された災害復旧により、上記のDockerセットアップを補完します。

> **注意:** コミュニティメンテナンスです。問題や貢献については、上記のリポジトリリンクを参照してください。

## 次のステップ

- メッセージングチャネルのセットアップ: [チャネル](/channels)
- Gateway ゲートウェイの設定: [Gateway ゲートウェイ設定](/gateway/configuration)
- OpenClawを最新の状態に保つ: [更新](/install/updating)
