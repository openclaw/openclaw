---
summary: "耐久性のある状態と組み込み済みバイナリを備え、安価な Hetzner VPS（Docker）で OpenClaw Gateway（ゲートウェイ）を 24/7 稼働させます"
read_when:
  - クラウド VPS（自分のノート PC ではない）で OpenClaw を 24/7 稼働させたい場合
  - 自分の VPS 上で本番品質の常時稼働 Gateway（ゲートウェイ）を運用したい場合
  - 永続化、バイナリ、再起動挙動を完全に制御したい場合
  - Hetzner もしくは同等プロバイダーで Docker 上に OpenClaw を実行している場合
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:25Z
---

# Hetzner 上の OpenClaw（Docker、本番 VPS ガイド）

## 目的

Docker を使用して Hetzner VPS 上で永続的な OpenClaw Gateway（ゲートウェイ）を実行し、耐久性のある状態、組み込み済みバイナリ、安全な再起動挙動を実現します。

「約 $5 で OpenClaw を 24/7 稼働」したい場合、これが最もシンプルで信頼性の高い構成です。  
Hetzner の料金は変更されるため、最小の Debian/Ubuntu VPS を選び、OOM が発生したらスケールアップしてください。

## 何をするのか（簡単に）

- 小さな Linux サーバー（Hetzner VPS）を借ります
- Docker（分離されたアプリ実行環境）をインストールします
- Docker で OpenClaw Gateway（ゲートウェイ）を起動します
- ホスト上で `~/.openclaw` と `~/.openclaw/workspace` を永続化します（再起動や再ビルド後も維持）
- SSH トンネル経由でノート PC から Control UI にアクセスします

Gateway（ゲートウェイ）へのアクセス方法:

- ノート PC からの SSH ポートフォワーディング
- ファイアウォールやトークン管理を自分で行う場合の直接ポート公開

このガイドは Hetzner 上の Ubuntu または Debian を前提としています。  
他の Linux VPS を使用している場合は、パッケージを適宜読み替えてください。  
汎用的な Docker フローについては、[Docker](/install/docker) を参照してください。

---

## クイックパス（経験者向け）

1. Hetzner VPS をプロビジョニング
2. Docker をインストール
3. OpenClaw リポジトリをクローン
4. 永続的なホストディレクトリを作成
5. `.env` と `docker-compose.yml` を設定
6. 必要なバイナリをイメージに組み込み
7. `docker compose up -d`
8. 永続化と Gateway（ゲートウェイ）へのアクセスを確認

---

## 必要なもの

- root 権限付きの Hetzner VPS
- ノート PC からの SSH アクセス
- SSH とコピペの基本的な操作
- 約 20 分
- Docker と Docker Compose
- モデルの認証情報
- 任意のプロバイダー認証情報
  - WhatsApp QR
  - Telegram ボットトークン
  - Gmail OAuth

---

## 1) VPS をプロビジョニング

Hetzner で Ubuntu または Debian の VPS を作成します。

root として接続します:

```bash
ssh root@YOUR_VPS_IP
```

このガイドでは、VPS はステートフルであることを前提としています。  
使い捨てのインフラとして扱わないでください。

---

## 2) Docker をインストール（VPS 上）

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

確認します:

```bash
docker --version
docker compose version
```

---

## 3) OpenClaw リポジトリをクローン

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

このガイドでは、バイナリの永続性を保証するためにカスタムイメージをビルドすることを前提としています。

---

## 4) 永続的なホストディレクトリを作成

Docker コンテナはエフェメラルです。  
長期的に保持すべき状態はすべてホスト上に置く必要があります。

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) 環境変数を設定

リポジトリのルートに `.env` を作成します。

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

強力なシークレットを生成します:

```bash
openssl rand -hex 32
```

**このファイルはコミットしないでください。**

---

## 6) Docker Compose 設定

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

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 7) 必要なバイナリをイメージに組み込む（重要）

実行中のコンテナ内にバイナリをインストールするのは罠です。  
実行時にインストールされたものは、再起動時にすべて失われます。

Skills に必要な外部バイナリは、すべてイメージのビルド時にインストールする必要があります。

以下の例では、一般的な 3 つのバイナリのみを示しています:

- Gmail アクセス用の `gog`
- Google Places 用の `goplaces`
- WhatsApp 用の `wacli`

これらは例であり、完全な一覧ではありません。  
同じパターンを使って、必要なだけバイナリをインストールできます。

後から追加のバイナリに依存する Skills を追加した場合は、次を行う必要があります:

1. Dockerfile を更新
2. イメージを再ビルド
3. コンテナを再起動

**Dockerfile の例**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

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

## 8) ビルドと起動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

バイナリを確認します:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

期待される出力:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Gateway（ゲートウェイ）を確認

```bash
docker compose logs -f openclaw-gateway
```

成功時:

```
[gateway] listening on ws://0.0.0.0:18789
```

ノート PC から:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

開きます:

`http://127.0.0.1:18789/`

Gateway トークンを貼り付けてください。

---

## 何がどこに永続化されるか（正本）

OpenClaw は Docker 上で動作しますが、Docker は正本ではありません。  
すべての長期的な状態は、再起動、再ビルド、再起動（リブート）後も維持される必要があります。

| コンポーネント               | 保存場所                          | 永続化の仕組み                | 注記                            |
| ---------------------------- | --------------------------------- | ----------------------------- | ------------------------------- |
| Gateway 設定                 | `/home/node/.openclaw/`           | ホストのボリュームマウント    | `openclaw.json`、トークンを含む |
| モデル認証プロファイル       | `/home/node/.openclaw/`           | ホストのボリュームマウント    | OAuth トークン、API キー        |
| Skill 設定                   | `/home/node/.openclaw/skills/`    | ホストのボリュームマウント    | Skill レベルの状態              |
| エージェントのワークスペース | `/home/node/.openclaw/workspace/` | ホストのボリュームマウント    | コードとエージェント成果物      |
| WhatsApp セッション          | `/home/node/.openclaw/`           | ホストのボリュームマウント    | QR ログインを保持               |
| Gmail キーリング             | `/home/node/.openclaw/`           | ホストボリューム + パスワード | `GOG_KEYRING_PASSWORD` が必要   |
| 外部バイナリ                 | `/usr/local/bin/`                 | Docker イメージ               | ビルド時に組み込む必要あり      |
| Node ランタイム              | コンテナのファイルシステム        | Docker イメージ               | イメージビルドごとに再構築      |
| OS パッケージ                | コンテナのファイルシステム        | Docker イメージ               | 実行時にインストールしない      |
| Docker コンテナ              | エフェメラル                      | 再起動可能                    | 破棄しても問題なし              |
