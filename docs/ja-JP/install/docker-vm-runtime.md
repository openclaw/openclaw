---
read_when:
    - クラウド VM に Docker で OpenClaw をデプロイしている
    - 共通のバイナリベイク、永続化、アップデートフローが必要
summary: 長期稼働する OpenClaw Gateway ゲートウェイホスト向けの共通 Docker VM ランタイム手順
title: Docker VM ランタイム
x-i18n:
    generated_at: "2026-04-02T07:45:11Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 072cf2aff56dad3d3d65ff5295e16f5a15ec62747cf56561d48a8a49ceed3e7f
    source_path: install/docker-vm-runtime.md
    workflow: 15
---

# Docker VM ランタイム

GCP、Hetzner、および同様の VPS プロバイダーなど、VM ベースの Docker インストール向けの共通ランタイム手順です。

## 必要なバイナリをイメージにベイクする

実行中のコンテナ内にバイナリをインストールするのは罠です。
ランタイム時にインストールしたものは再起動で失われます。

Skills に必要なすべての外部バイナリは、イメージのビルド時にインストールする必要があります。

以下の例では、一般的な3つのバイナリのみを示しています：

- `gog` - Gmail アクセス用
- `goplaces` - Google Places 用
- `wacli` - WhatsApp 用

これらは例であり、完全なリストではありません。
同じパターンを使用して、必要なだけバイナリをインストールできます。

後から追加のバイナリに依存する新しい Skills を追加する場合は、以下を行う必要があります：

1. Dockerfile を更新する
2. イメージをリビルドする
3. コンテナを再起動する

**Dockerfile の例**

```dockerfile
FROM node:24-bookworm

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

<Note>
上記のダウンロード URL は x86_64（amd64）用です。ARM ベースの VM（例：Hetzner ARM、GCP Tau T2A）の場合は、各ツールのリリースページから適切な ARM64 バリアントのダウンロード URL に置き換えてください。
</Note>

## ビルドと起動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

`pnpm install --frozen-lockfile` の実行中にビルドが `Killed` または `exit code 137` で失敗した場合、VM のメモリが不足しています。
リトライする前に、より大きなマシンクラスを使用してください。

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

Gateway ゲートウェイの確認：

```bash
docker compose logs -f openclaw-gateway
```

期待される出力：

```
[gateway] listening on ws://0.0.0.0:18789
```

## 永続化の場所

OpenClaw は Docker 内で実行されますが、Docker は信頼できる情報源ではありません。
すべての長期的な状態は、再起動、リビルド、リブートに耐えられる必要があります。

| コンポーネント        | 場所                              | 永続化メカニズム         | 備考                             |
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |
| Gateway ゲートウェイ設定 | `/home/node/.openclaw/`           | ホストボリュームマウント   | `openclaw.json`、トークンを含む    |
| モデル認証プロファイル  | `/home/node/.openclaw/`           | ホストボリュームマウント   | OAuth トークン、API キー           |
| Skills 設定          | `/home/node/.openclaw/skills/`    | ホストボリュームマウント   | Skills レベルの状態                |
| エージェントワークスペース | `/home/node/.openclaw/workspace/` | ホストボリュームマウント   | コードとエージェント成果物          |
| WhatsApp セッション   | `/home/node/.openclaw/`           | ホストボリュームマウント   | QR ログインを保持                  |
| Gmail キーリング      | `/home/node/.openclaw/`           | ホストボリューム + パスワード | `GOG_KEYRING_PASSWORD` が必要     |
| 外部バイナリ          | `/usr/local/bin/`                 | Docker イメージ          | ビルド時にベイクが必要              |
| Node ランタイム       | コンテナファイルシステム             | Docker イメージ          | イメージビルドのたびにリビルド       |
| OS パッケージ         | コンテナファイルシステム             | Docker イメージ          | ランタイム時にインストールしないこと  |
| Docker コンテナ       | エフェメラル                        | 再起動可能               | 破棄しても安全                     |

## アップデート

VM 上の OpenClaw をアップデートするには：

```bash
git pull
docker compose build
docker compose up -d
```
