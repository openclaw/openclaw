---
summary: "安価なHetzner VPS（Docker）上で耐久性のある状態と組み込みバイナリを持つOpenClaw Gatewayを24時間365日稼働させる"
read_when:
  - クラウドVPS上でOpenClawを24時間365日稼働させたい場合（ラップトップではなく）
  - 本番グレードの常時稼働Gatewayを自分のVPS上で実行したい場合
  - 永続性、バイナリ、再起動動作を完全に制御したい場合
  - Hetznerまたは類似のプロバイダー上でDockerでOpenClawを実行している場合
title: "Hetzner"
---

# Hetzner上のOpenClaw（Docker、本番VPSガイド）

## 目標

Hetzner VPS上でDockerを使用して永続的なOpenClaw Gatewayを実行します。耐久性のある状態、組み込みバイナリ、安全な再起動動作を備えています。

「OpenClawを約5ドルで24時間365日」稼働させたい場合、これが最もシンプルで信頼性の高いセットアップです。
Hetznerの料金は変更される可能性があります。最小のDebian/Ubuntu VPSを選択し、OOMが発生した場合はスケールアップしてください。

セキュリティモデルの注意：

- 同じ信頼境界内の全員がビジネス専用のランタイムを使用する場合、会社共有のエージェントで問題ありません。
- 厳格な分離を維持：専用VPS/ランタイム + 専用アカウント。そのホストに個人のApple/Google/ブラウザ/パスワードマネージャーのプロファイルを置かないでください。
- ユーザー同士が敵対的な場合は、Gateway/ホスト/OSユーザーで分離してください。

[セキュリティ](/gateway/security)と[VPSホスティング](/vps)を参照してください。

## やること（簡単な説明）

- 小さなLinuxサーバー（Hetzner VPS）をレンタル
- Docker（隔離されたアプリランタイム）をインストール
- DockerでOpenClaw Gatewayを起動
- ホスト上に`~/.openclaw` + `~/.openclaw/workspace`を永続化（再起動/再ビルド後も維持）
- SSHトンネルを使ってラップトップからControl UIにアクセス

Gatewayには以下の方法でアクセスできます：

- ラップトップからのSSHポートフォワーディング
- ファイアウォールとトークンを自分で管理する場合は直接ポート公開

このガイドではHetzner上のUbuntuまたはDebianを前提としています。
他のLinux VPSを使用している場合は、パッケージを適宜マッピングしてください。
一般的なDockerフローについては、[Docker](/install/docker)を参照してください。

---

## クイックパス（経験者向け）

1. Hetzner VPSをプロビジョニング
2. Dockerをインストール
3. OpenClawリポジトリをクローン
4. 永続的なホストディレクトリを作成
5. `.env`と`docker-compose.yml`を設定
6. 必要なバイナリをイメージに組み込み
7. `docker compose up -d`
8. 永続性とGatewayアクセスを確認

---

## 必要なもの

- root権限を持つHetzner VPS
- ラップトップからのSSHアクセス
- SSH + コピー/ペーストの基本的な知識
- 約20分
- DockerとDocker Compose
- モデル認証の認証情報
- オプションのプロバイダー認証情報
  - WhatsApp QR
  - Telegramボットトークン
  - Gmail OAuth

---

## 1）VPSのプロビジョニング

HetznerでUbuntuまたはDebian VPSを作成します。

rootとして接続：

```bash
ssh root@YOUR_VPS_IP
```

このガイドではVPSがステートフルであることを前提としています。
使い捨てインフラストラクチャとして扱わないでください。

---

## 2）Dockerのインストール（VPS上）

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

確認：

```bash
docker --version
docker compose version
```

---

## 3）OpenClawリポジトリのクローン

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

このガイドでは、バイナリの永続性を保証するためにカスタムイメージをビルドすることを前提としています。

---

## 4）永続的なホストディレクトリの作成

Dockerコンテナはエフェメラルです。
すべての長期的な状態はホスト上に存在する必要があります。

```bash
mkdir -p /root/.openclaw/workspace

# コンテナユーザー（uid 1000）に所有権を設定：
chown -R 1000:1000 /root/.openclaw
```

---

## 5）環境変数の設定

リポジトリルートに`.env`を作成してください。

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

強力なシークレットを生成：

```bash
openssl rand -hex 32
```

**このファイルをコミットしないでください。**

---

## 6）Docker Compose設定

`docker-compose.yml`を作成または更新してください。

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
      # 推奨：VPS上ではGatewayをループバックのみに保ち、SSHトンネル経由でアクセスしてください。
      # パブリックに公開するには、`127.0.0.1:`プレフィックスを削除し、適切にファイアウォールを設定してください。
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

`--allow-unconfigured`はブートストラップの便宜のためだけであり、適切なGateway設定の代わりにはなりません。認証（`gateway.auth.token`またはパスワード）を設定し、デプロイメントに安全なバインド設定を使用してください。

---

## 7）必要なバイナリをイメージに組み込み（重要）

実行中のコンテナ内にバイナリをインストールするのは落とし穴です。
ランタイムでインストールしたものは再起動時に失われます。

スキルが必要とするすべての外部バイナリはイメージビルド時にインストールする必要があります。

以下の例は3つの一般的なバイナリのみを示しています：

- `gog`（Gmailアクセス用）
- `goplaces`（Google Places用）
- `wacli`（WhatsApp用）

これらは例であり、完全なリストではありません。
同じパターンで必要なだけバイナリをインストールできます。

後で追加のバイナリに依存する新しいスキルを追加する場合：

1. Dockerfileを更新
2. イメージを再ビルド
3. コンテナを再起動

**Dockerfileの例**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# バイナリ例1：Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# バイナリ例2：Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# バイナリ例3：WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 同じパターンで以下にバイナリを追加

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8）ビルドと起動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

バイナリの確認：

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

期待される出力：

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9）Gatewayの確認

```bash
docker compose logs -f openclaw-gateway
```

成功の場合：

```
[gateway] listening on ws://0.0.0.0:18789
```

ラップトップから：

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

ブラウザで開きます：

`http://127.0.0.1:18789/`

Gatewayトークンを貼り付けてください。

---

## 永続化の場所（正本）

OpenClawはDockerで実行されますが、Dockerは正本ではありません。
すべての長期的な状態は再起動、再ビルド、リブートを生き残る必要があります。

| コンポーネント           | 場所                          | 永続化メカニズム  | 備考                            |
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |
| Gateway設定      | `/home/node/.openclaw/`           | ホストボリュームマウント      | `openclaw.json`、トークンを含む |
| モデル認証プロファイル | `/home/node/.openclaw/`           | ホストボリュームマウント      | OAuthトークン、APIキー           |
| スキル設定       | `/home/node/.openclaw/skills/`    | ホストボリュームマウント      | スキルレベルの状態                |
| エージェントワークスペース     | `/home/node/.openclaw/workspace/` | ホストボリュームマウント      | コードとエージェントアーティファクト         |
| WhatsAppセッション    | `/home/node/.openclaw/`           | ホストボリュームマウント      | QRログインを保持               |
| Gmailキーリング       | `/home/node/.openclaw/`           | ホストボリューム + パスワード | `GOG_KEYRING_PASSWORD`が必要  |
| 外部バイナリ   | `/usr/local/bin/`                 | Dockerイメージ           | ビルド時に組み込む必要あり      |
| Nodeランタイム        | コンテナファイルシステム              | Dockerイメージ           | イメージビルドごとに再ビルド        |
| OSパッケージ         | コンテナファイルシステム              | Dockerイメージ           | ランタイムでインストールしないこと        |
| Dockerコンテナ    | エフェメラル                         | 再起動可能            | 破棄しても安全                  |

---

## Infrastructure as Code（Terraform）

Infrastructure-as-Codeワークフローを好むチームのために、コミュニティがメンテナンスするTerraformセットアップが提供されています：

- リモート状態管理を備えたモジュラーTerraform構成
- cloud-initによる自動プロビジョニング
- デプロイメントスクリプト（ブートストラップ、デプロイ、バックアップ/リストア）
- セキュリティ強化（ファイアウォール、UFW、SSHのみのアクセス）
- Gatewayアクセス用のSSHトンネル設定

**リポジトリ：**

- インフラストラクチャ：[openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker設定：[openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

このアプローチは上記のDockerセットアップを補完し、再現可能なデプロイメント、バージョン管理されたインフラストラクチャ、自動化された災害復旧を提供します。

> **注意：** コミュニティがメンテナンスしています。問題やコントリビューションについては、上記のリポジトリリンクを参照してください。
