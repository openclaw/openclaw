---
summary: "OpenClaw 向けのオプションの Docker ベースのセットアップおよびオンボーディング"
read_when:
  - ローカルインストールではなくコンテナ化された ゲートウェイ を使いたい場合
  - Docker フローを検証している場合
title: "Docker"
---

# Docker（オプション）

Docker は **任意** です。 Docker は **オプション** です。コンテナ化された ゲートウェイ を使いたい場合、または Docker フローを検証したい場合にのみ使用してください。

## Docker は自分に向いていますか？

- **はい**：分離された使い捨ての ゲートウェイ 環境が必要、またはローカルインストールなしで OpenClaw をホスト上で実行したい場合。
- **いいえ**：自分のマシンで実行し、最速の開発ループが欲しいだけの場合。通常のインストール フローを使用してください。 代わりに通常のインストール フローを使用します。
- **サンドボックス化に関する注記**：エージェントのサンドボックス化でも Docker を使用しますが、完全な ゲートウェイ を Docker で実行する必要は **ありません**。[Sandboxing](/gateway/sandboxing) を参照してください。 [Sandboxing](/gateway/sandboxing) を参照してください。

このガイドの内容：

- コンテナ化された Gateway（Docker 内での完全な OpenClaw）
- セッションごとの エージェント サンドボックス（ホスト上の ゲートウェイ + Docker で分離されたエージェント ツール）

サンドボックス化の詳細：[Sandboxing](/gateway/sandboxing)

## 要件

- Docker Desktop（または Docker Engine）+ Docker Compose v2
- イメージおよびログ用の十分なディスク容量

## コンテナ化された Gateway（Docker Compose）

### クイックスタート（推奨）

リポジトリのルートから：

```bash
./docker-setup.sh
```

このスクリプトは次を行います：

- ゲートウェイ イメージをビルド
- オンボーディング ウィザードを実行
- オプションのプロバイダ設定ヒントを印刷
- Docker Compose 経由で ゲートウェイ を起動
- ゲートウェイ トークンを生成し、`.env` に書き込み

オプションのenv vars:

- `OPENCLAW_DOCKER_APT_PACKAGES` — ビルド中に追加の apt パッケージをインストール
- `OPENCLAW_EXTRA_MOUNTS` — 追加のホスト バインド マウントを追加
- `OPENCLAW_HOME_VOLUME` — 名前付きボリュームに `/home/node` を永続化

完了後：

- ブラウザーで `http://127.0.0.1:18789/` を開きます。
- Control UI（Settings → token）にトークンを貼り付けます。
- もう一度URLを入力しますか？ URL が再度必要ですか？`docker compose run --rm openclaw-cli dashboard --no-open` を実行してください。

ホスト上に 設定 / ワークスペース を書き込みます：

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPSで実行していますか？ VPS で実行していますか？[Hetzner（Docker VPS）](/install/hetzner) を参照してください。

### 手動フロー（compose）

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Note: repoルートから`docker compose ...`を実行します。 注記：リポジトリ ルートから `docker compose ...` を実行してください。  
`OPENCLAW_EXTRA_MOUNTS` または `OPENCLAW_HOME_VOLUME` を有効にした場合、セットアップ スクリプトは
`docker-compose.extra.yml` を書き込みます。別の場所で Compose を実行する際は、これを含めてください：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI トークン + ペアリング（Docker）

「unauthorized」または「disconnected（1008）：pairing required」と表示される場合は、
新しいダッシュボード リンクを取得し、ブラウザー デバイスを承認してください：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

詳細：[Dashboard](/web/dashboard)、[Devices](/cli/devices)。

### 追加マウント（オプション）

追加のホスト ディレクトリをコンテナにマウントしたい場合は、
`docker-setup.sh` を実行する前に `OPENCLAW_EXTRA_MOUNTS` を設定してください。これは
Docker のバインド マウントのカンマ区切りリストを受け取り、`openclaw-gateway` と
`openclaw-cli` の両方に適用するため、`docker-compose.extra.yml` を生成します。 これは
コンマで区切られた Docker バインドマウントのリストを受け取り、`docker-compose.extra.yml` を生成することで
`openclaw-gateway` と `openclaw-cli` の両方に適用されます。

例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注記：

- macOS / Windows では、パスを Docker Desktop と共有する必要があります。
- `OPENCLAW_EXTRA_MOUNTS` を編集した場合、`docker-setup.sh` を再実行して
  追加の compose ファイルを再生成してください。
- `docker-compose.extra.yml` は生成物です。手動で編集しないでください。 手作業で編集しないでください。

### コンテナの home 全体を永続化（オプション）

`/home/node` をコンテナ再作成後も永続化したい場合は、
`OPENCLAW_HOME_VOLUME` で名前付きボリュームを設定してください。これにより Docker ボリュームが作成され、
`/home/node` にマウントされます。標準の 設定 / ワークスペース のバインド マウントは維持されます。
ここでは名前付きボリュームを使用してください（バインド パスではありません）。
バインド マウントを使用する場合は、`OPENCLAW_EXTRA_MOUNTS` を使用してください。 これにより、Docker ボリュームが作成され、
`/home/node` にマウントされ、標準の config/workspace バインドマウントが維持されます。 32. ここでは名前付きボリュームを使用してください（バインドパスではありません）。バインドマウントの場合は `OPENCLAW_EXTRA_MOUNTS` を使用します。

例：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

追加マウントと組み合わせることもできます：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注記：

- `OPENCLAW_HOME_VOLUME` を変更した場合、`docker-setup.sh` を再実行して
  追加の compose ファイルを再生成してください。
- 名前付きボリュームは、`docker volume rm <name>` で削除するまで保持されます。

### 追加の apt パッケージをインストール（オプション）

イメージ内にシステム パッケージ（例：ビルド ツールやメディア ライブラリ）が必要な場合は、
`docker-setup.sh` を実行する前に `OPENCLAW_DOCKER_APT_PACKAGES` を設定してください。
これはイメージ ビルド中にパッケージをインストールするため、コンテナを削除しても保持されます。
これにより、イメージビルド中にパッケージがインストールされるため、
コンテナが削除されても継続します。

例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注記：

- apt パッケージ名のスペース区切りリストを受け取ります。
- `OPENCLAW_DOCKER_APT_PACKAGES` を変更した場合、`docker-setup.sh` を再実行して
  イメージを再ビルドしてください。

### パワーユーザー / フル機能コンテナ（オプトイン）

既定の Docker イメージは **セキュリティ重視** で、非 root の `node`
ユーザーとして実行されます。これにより攻撃面は小さくなりますが、次の制限があります： これにより、攻撃面が小さくなりますが、それは以下のことを意味します。

- 実行時のシステム パッケージ インストール不可
- 既定では Homebrew なし
- Chromium / Playwright ブラウザーは同梱されない

よりフル機能なコンテナが必要な場合は、次のオプトイン設定を使用してください：

1. **`/home/node` を永続化** して、ブラウザー ダウンロードやツール キャッシュを保持：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **システム依存関係をイメージに焼き込み**（再現可能 + 永続）：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` を使わずに Playwright ブラウザーをインストール**（npm の上書き競合を回避）：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Playwright にシステム依存関係のインストールが必要な場合は、
実行時に `--with-deps` を使用する代わりに、
`OPENCLAW_DOCKER_APT_PACKAGES` でイメージを再ビルドしてください。

4. **Playwright ブラウザーのダウンロードを永続化**：

- `docker-compose.yml` で `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` を設定。
- `OPENCLAW_HOME_VOLUME` により `/home/node` が永続化されることを確認するか、
  `OPENCLAW_EXTRA_MOUNTS` で `/home/node/.cache/ms-playwright` をマウントしてください。

### 権限 + EACCES

イメージは `node` (uid 1000) として実行されます。 イメージは `node`（uid 1000）として実行されます。`/home/node/.openclaw` に対する
権限エラーが表示される場合は、ホストのバインド マウントが uid 1000 の所有になっていることを確認してください。

例（Linux ホスト）：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

利便性のために root として実行する場合、セキュリティ上のトレードオフを受け入れる必要があります。

### 高速な再ビルド（推奨）

再ビルドを高速化するには、Dockerfile 内で依存関係レイヤーがキャッシュされるように順序を調整してください。
これにより、ロックファイルが変更されない限り `pnpm install` の再実行を回避できます：
ロックファイルが変更されない限り、 `pnpm install` の再実行を回避します。

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### チャンネル セットアップ（オプション）

CLI コンテナを使用して チャンネル を設定し、必要に応じて ゲートウェイ を再起動してください。

WhatsApp（QR）：

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram（ボットトークン）：

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord（ボットトークン）：

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

ドキュメント：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

### OpenAI Codex OAuth（ヘッドレス Docker）

ウィザードで OpenAI Codex OAuth を選択すると、ブラウザー URL が開かれ、
`http://127.0.0.1:1455/auth/callback` でのコールバック取得を試みます。Docker や
ヘッドレス環境では、このコールバックでブラウザー エラーが表示される場合があります。
最終的に到達した完全なリダイレクト URL をコピーし、ウィザードに貼り付けて認証を完了してください。 Docker または
では、コールバックにブラウザエラーが表示されるヘッドレス設定があります。 完全なリダイレクト
URLをコピーし、ウィザードに貼り付けて認証を完了します。

### ヘルスチェック

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E スモークテスト（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### QR インポート スモークテスト（Docker）

```bash
pnpm test:docker:qr
```

### 注記

- Gateway のバインドは、コンテナ用途では既定で `lan` です。
- Dockerfile の CMD は `--allow-unconfigured` を使用します。`local` ではなく
  `gateway.mode` を用いてマウントされた設定でも起動します。ガードを強制するには CMD を上書きしてください。 ガードを強制するためにCMDを上書きします。
- ゲートウェイ コンテナは、セッション（`~/.openclaw/agents/<agentId>/sessions/`）の信頼できる情報源です。

## エージェント サンドボックス（ホスト ゲートウェイ + Docker ツール）

詳細：[Sandboxing](/gateway/sandboxing)

### 何をするか

`agents.defaults.sandbox` を有効にすると、**メイン以外のセッション** は Docker
コンテナ内でツールを実行します。ゲートウェイ はホストに残り、ツール実行のみが分離されます： ゲートウェイはホスト上にとどまりますが、ツールの実行は分離されています:

- スコープ：既定で `"agent"`（エージェントごとに 1 コンテナ + ワークスペース）
- スコープ：セッションごとの分離には `"session"`
- スコープごとのワークスペース フォルダーが `/workspace` にマウント
- オプションの エージェント ワークスペース アクセス（`agents.defaults.sandbox.workspaceAccess`）
- ツールの許可 / 拒否ポリシー（拒否が優先）
- 受信メディアはアクティブなサンドボックス ワークスペース（`media/inbound/*`）にコピーされ、
  ツールが読み取れるようになります（`workspaceAccess: "rw"` を使用すると、エージェント ワークスペースに配置されます）

警告：`scope: "shared"` はセッション間の分離を無効化します。すべてのセッションが
1 つのコンテナと 1 つのワークスペースを共有します。 すべてのセッションは
コンテナ1つとワークスペース1つを共有します。

### エージェントごとのサンドボックス プロファイル（マルチエージェント）

マルチエージェント ルーティングを使用する場合、各エージェントは
`agents.list[].sandbox` および `agents.list[].tools`（および `agents.list[].tools.sandbox.tools`）を上書きできます。
これにより、1 つの ゲートウェイ で異なるアクセス レベルを混在させられます： これにより、1 つのゲートウェイで
混合アクセスレベルを実行できます。

- フル アクセス（個人用エージェント）
- 読み取り専用ツール + 読み取り専用ワークスペース（家族 / 業務用エージェント）
- ファイルシステム / シェル ツールなし（公開エージェント）

例、優先順位、トラブルシューティングについては
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) を参照してください。

### 既定の挙動

- イメージ：`openclaw-sandbox:bookworm-slim`
- エージェントごとに 1 コンテナ
- エージェント ワークスペース アクセス：`workspaceAccess: "none"`（既定）は `~/.openclaw/sandboxes` を使用
  - `"ro"` はサンドボックス ワークスペースを `/workspace` に保持し、
    エージェント ワークスペースを `/agent` に読み取り専用でマウント
    （`write` / `edit` / `apply_patch` を無効化）
  - `"rw"` はエージェント ワークスペースを `/workspace` に読み書きでマウント
- 自動プルーン：アイドル > 24 時間 または 経過 > 7 日
- ネットワーク：既定で `none`（外向き通信が必要な場合は明示的にオプトイン）
- 既定で許可：`exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- 既定で拒否：`browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### サンドボックス化を有効化

`setupCommand` にパッケージをインストールする予定がある場合、次に注意してください：

- 既定の `docker.network` は `"none"`（外向き通信なし）です。
- `readOnlyRoot: true` はパッケージ インストールをブロックします。
- `apt-get` の場合は`user` をルートにする必要があります(`user` を省略するか、`user: "0:0"`を設定します)。
  `setupCommand` (またはdocker config) が
  に変更されたときに、コンテナが**最近使用された** (約 5 分以内) でない限り、OpenClaw はコンテナを自動的に再作成します。 ホットコンテナ
  は `openclawサンドボックスを再作成する...`コマンドで警告をログに記録します。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

ハードニング設定は `agents.defaults.sandbox.docker` 配下にあります：
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`。

マルチエージェント：`agents.list[].sandbox.{docker,browser,prune}.*` を使用して、エージェントごとに `agents.defaults.sandbox.{docker,browser,prune}.*` を上書き
（`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` が `"shared"` の場合は無視されます）。

### 既定のサンドボックス イメージをビルド

```bash
scripts/sandbox-setup.sh
```

これは `Dockerfile.sandbox` を使用して `openclaw-sandbox:bookworm-slim` をビルドします。

### サンドボックス 共通イメージ（オプション）

一般的なビルド ツール（Node、Go、Rust など）を含むサンドボックス イメージが必要な場合は、
共通イメージをビルドしてください：

```bash
scripts/sandbox-common-setup.sh
```

これは `openclaw-sandbox-common:bookworm-slim` をビルドします。使用するには： 使用するには:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### サンドボックス ブラウザー イメージ

サンドボックス内でブラウザー ツールを実行するには、ブラウザー イメージをビルドします：

```bash
scripts/sandbox-browser-setup.sh
```

これは
`Dockerfile.sandbox-browser` を使用して `openclaw-sandbox-browser:bookworm-slim` をビルドします。 このコンテナは、CDPが有効な状態でChromiumを実行し、オプションのnoVNCオブザーバー(Xvfbを介してヘッドフル)を
します。

注記：

- ヘッドフル（Xvfb）は、ヘッドレスよりもボット ブロッキングを低減します。
- `agents.defaults.sandbox.browser.headless=true` を設定すれば、ヘッドレスも使用できます。
- 完全なデスクトップ環境（GNOME）は不要で、Xvfb が表示を提供します。

使用する設定：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

カスタム ブラウザー イメージ：

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

有効化すると、エージェントは次を受け取ります：

- サンドボックス ブラウザー制御 URL（`browser` ツール用）
- noVNC URL（有効化され、headless=false の場合）

ツールに許可リストを使用している場合は、`browser` を追加（そして
拒否から削除）するか、ツールがブロックされたままになります。
prune rules (`agents.defaults.sandbox.prune`) はブラウザコンテナにも適用されます。

### カスタム サンドボックス イメージ

独自のイメージをビルドし、設定で指定してください：

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### ツール ポリシー（許可 / 拒否）

- `deny` は `allow` より優先されます。
- `allow` が空の場合：拒否を除くすべてのツールが利用可能です。
- `allow` が非空の場合：`allow` 内のツールのみが利用可能です（拒否を除く）。

### プルーン戦略

2 つの設定：

- `prune.idleHours`：X 時間使用されていないコンテナを削除（0 = 無効）
- `prune.maxAgeDays`：X 日より古いコンテナを削除（0 = 無効）

例：

- 忙しいセッションを維持しつつ寿命を制限：
  `idleHours: 24`, `maxAgeDays: 7`
- プルーンしない：
  `idleHours: 0`, `maxAgeDays: 0`

### セキュリティ注記

- ハード ウォールは **ツール**（exec/read/write/edit/apply_patch）にのみ適用されます。
- browser/camera/canvas などのホスト専用ツールは、既定でブロックされます。
- サンドボックスで `browser` を許可すると **分離が破壊** されます（ブラウザーがホストで実行されます）。

## トラブルシューティング

- イメージが見つからない：[`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) でビルドするか、`agents.defaults.sandbox.docker.image` を設定してください。
- コンテナが実行されない：必要に応じて、セッションごとに自動作成されます。
- サンドボックス内の権限エラー：`docker.user` を、マウントされたワークスペースの所有者に一致する UID:GID に設定してください
  （またはワークスペース フォルダーを chown してください）。
- カスタムツールが見つかりません: OpenClawは`sh -lc` (ログインシェル) を使用してコマンドを実行します。
  `/etc/profile` をソースにしてPATHをリセットすることができます。 カスタム ツールが見つからない：OpenClaw は `sh -lc`（ログイン シェル）でコマンドを実行し、
  `/etc/profile` を読み込むため PATH がリセットされる場合があります。`docker.env.PATH` を設定して
  カスタム ツールのパス（例：`/custom/bin:/usr/local/share/npm-global/bin`）を先頭に追加するか、
  Dockerfile 内で `/etc/profile.d/` 配下にスクリプトを追加してください。
