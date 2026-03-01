---
summary: "GCP Compute Engine VM（Docker）上で永続的な状態を持つOpenClaw Gatewayを24時間365日稼働させる"
read_when:
  - GCP上でOpenClawを24時間365日稼働させたい場合
  - 本番グレードの常時稼働Gatewayを自分のVM上で実行したい場合
  - 永続性、バイナリ、再起動動作を完全に制御したい場合
title: "GCP"
---

# GCP Compute Engine上のOpenClaw（Docker、本番VPSガイド）

## 目標

GCP Compute Engine VM上でDockerを使用して永続的なOpenClaw Gatewayを実行します。耐久性のある状態、組み込みバイナリ、安全な再起動動作を備えています。

「OpenClawを月額約5-12ドルで24時間365日稼働」させたい場合、これはGoogle Cloud上の信頼性の高いセットアップです。
料金はマシンタイプとリージョンによって異なります。ワークロードに合う最小のVMを選択し、OOMが発生した場合はスケールアップしてください。

## やること（簡単な説明）

- GCPプロジェクトを作成し、課金を有効にする
- Compute Engine VMを作成する
- Docker（隔離されたアプリランタイム）をインストールする
- DockerでOpenClaw Gatewayを起動する
- ホスト上に`~/.openclaw` + `~/.openclaw/workspace`を永続化（再起動/再ビルド後も維持）
- SSHトンネルを使ってラップトップからControl UIにアクセスする

Gatewayには以下の方法でアクセスできます：

- ラップトップからのSSHポートフォワーディング
- ファイアウォールとトークンを自分で管理する場合は直接ポート公開

このガイドではGCP Compute Engine上のDebianを使用します。
Ubuntuも動作します。パッケージを適宜マッピングしてください。
一般的なDockerフローについては、[Docker](/install/docker)を参照してください。

---

## クイックパス（経験者向け）

1. GCPプロジェクトを作成 + Compute Engine APIを有効化
2. Compute Engine VM を作成（e2-small、Debian 12、20GB）
3. VMにSSHで接続
4. Dockerをインストール
5. OpenClawリポジトリをクローン
6. 永続的なホストディレクトリを作成
7. `.env`と`docker-compose.yml`を設定
8. 必要なバイナリを組み込み、ビルドして起動

---

## 必要なもの

- GCPアカウント（e2-microは無料枠の対象）
- gcloud CLIがインストール済み（またはCloud Consoleを使用）
- ラップトップからのSSHアクセス
- SSH + コピー/ペーストの基本的な知識
- 約20-30分
- DockerとDocker Compose
- モデル認証の認証情報
- オプションのプロバイダー認証情報
  - WhatsApp QR
  - Telegramボットトークン
  - Gmail OAuth

---

## 1）gcloud CLIのインストール（またはConsoleを使用）

**オプションA：gcloud CLI**（自動化に推奨）

[https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)からインストールしてください。

初期化と認証：

```bash
gcloud init
gcloud auth login
```

**オプションB：Cloud Console**

すべてのステップは[https://console.cloud.google.com](https://console.cloud.google.com)のWeb UIから実行できます。

---

## 2）GCPプロジェクトの作成

**CLI：**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

[https://console.cloud.google.com/billing](https://console.cloud.google.com/billing)で課金を有効にしてください（Compute Engineに必要）。

Compute Engine APIを有効化：

```bash
gcloud services enable compute.googleapis.com
```

**Console：**

1. IAM & Admin > プロジェクトの作成に移動
2. 名前を付けて作成
3. プロジェクトの課金を有効にする
4. APIs & Services > APIの有効化 > 「Compute Engine API」を検索 > 有効にする

---

## 3）VMの作成

**マシンタイプ：**

| タイプ      | スペック                    | コスト               | 備考                                        |
| --------- | ------------------------ | ------------------ | -------------------------------------------- |
| e2-medium | 2 vCPU、4GB RAM          | 月額約25ドル            | ローカルDockerビルドに最も信頼性が高い        |
| e2-small  | 2 vCPU、2GB RAM          | 月額約12ドル            | Dockerビルドの最小推奨         |
| e2-micro  | 2 vCPU（共有）、1GB RAM | 無料枠の対象 | DockerビルドのOOM（exit 137）で失敗することが多い |

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

1. Compute Engine > VMインスタンス > インスタンスの作成に移動
2. 名前：`openclaw-gateway`
3. リージョン：`us-central1`、ゾーン：`us-central1-a`
4. マシンタイプ：`e2-small`
5. ブートディスク：Debian 12、20GB
6. 作成

---

## 4）VMにSSHで接続

**CLI：**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console：**

Compute Engineダッシュボードで、VMの横にある「SSH」ボタンをクリックしてください。

注意：VM作成後、SSHキーの伝播に1-2分かかる場合があります。接続が拒否された場合は、しばらく待ってから再試行してください。

---

## 5）Dockerのインストール（VM上）

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

グループの変更を有効にするために、ログアウトして再度ログインしてください：

```bash
exit
```

その後、再度SSHで接続：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

確認：

```bash
docker --version
docker compose version
```

---

## 6）OpenClawリポジトリのクローン

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

このガイドでは、バイナリの永続性を保証するためにカスタムイメージをビルドすることを前提としています。

---

## 7）永続的なホストディレクトリの作成

Dockerコンテナはエフェメラルです。
すべての長期的な状態はホスト上に存在する必要があります。

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8）環境変数の設定

リポジトリルートに`.env`を作成してください。

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

**このファイルをコミットしないでください。**

---

## 9）Docker Compose設定

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
      # 推奨：VM上ではGatewayをループバックのみに保ち、SSHトンネル経由でアクセスしてください。
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
      ]
```

---

## 10）必要なバイナリをイメージに組み込み（重要）

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

## 11）ビルドと起動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

`pnpm install --frozen-lockfile`中に`Killed` / `exit code 137`でビルドが失敗した場合、VMのメモリが不足しています。最低でも`e2-small`を使用するか、信頼性の高い初回ビルドには`e2-medium`を使用してください。

LAN（`OPENCLAW_GATEWAY_BIND=lan`）にバインドする場合、続行する前に信頼されたブラウザオリジンを設定してください：

```bash
docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
```

Gatewayポートを変更した場合は、`18789`を設定したポートに置き換えてください。

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

## 12）Gatewayの確認

```bash
docker compose logs -f openclaw-gateway
```

成功の場合：

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13）ラップトップからのアクセス

Gatewayポートを転送するSSHトンネルを作成します：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

ブラウザで開きます：

`http://127.0.0.1:18789/`

トークン付きダッシュボードリンクを取得：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
```

そのURLからトークンを貼り付けてください。

Control UIに`unauthorized`または`disconnected (1008): pairing required`と表示された場合は、ブラウザデバイスを承認してください：

```bash
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

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

## アップデート

VM上のOpenClawをアップデートするには：

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## トラブルシューティング

**SSH接続拒否**

VM作成後、SSHキーの伝播に1-2分かかる場合があります。待ってから再試行してください。

**OS Loginの問題**

OS Loginプロファイルを確認してください：

```bash
gcloud compute os-login describe-profile
```

アカウントに必要なIAMパーミッション（Compute OS LoginまたはCompute OS Admin Login）があることを確認してください。

**メモリ不足（OOM）**

Dockerビルドが`Killed`と`exit code 137`で失敗した場合、VMがOOM-killされました。e2-small（最小）またはe2-medium（信頼性の高いローカルビルドに推奨）にアップグレードしてください：

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

個人使用では、デフォルトのユーザーアカウントで十分です。

自動化やCI/CDパイプラインの場合は、最小限のパーミッションを持つ専用サービスアカウントを作成してください：

1. サービスアカウントを作成：

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Adminロール（またはより狭いカスタムロール）を付与：

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

自動化にはOwnerロールの使用を避けてください。最小権限の原則を使用してください。

IAMロールの詳細については[https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)を参照してください。

---

## 次のステップ

- メッセージングチャンネルのセットアップ：[チャンネル](/channels)
- ローカルデバイスをノードとしてペアリング：[ノード](/nodes)
- Gatewayの設定：[Gateway設定](/gateway/configuration)
