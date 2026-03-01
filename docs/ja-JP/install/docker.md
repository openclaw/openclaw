---
summary: "OpenClawのオプションのDockerベースのセットアップとオンボーディング"
read_when:
  - ローカルインストールの代わりにコンテナ化されたGatewayを使いたい場合
  - Dockerフローを検証する場合
title: "Docker"
---

# Docker（オプション）

Dockerは**オプション**です。コンテナ化されたGatewayが必要な場合、またはDockerフローを検証する場合にのみ使用してください。

## Dockerは自分に適していますか？

- **はい**：隔離された使い捨てのGateway環境が必要な場合、またはローカルインストールなしでホスト上でOpenClawを実行したい場合。
- **いいえ**：自分のマシンで最速の開発ループが必要な場合。代わりに通常のインストールフローを使用してください。
- **サンドボックスに関する注意**：エージェントのサンドボックスもDockerを使用しますが、Gateway全体をDockerで実行する必要は**ありません**。[サンドボックス](/gateway/sandboxing)を参照してください。

このガイドでは以下をカバーします：

- コンテナ化されたGateway（Docker内の完全なOpenClaw）
- セッションごとのエージェントサンドボックス（ホストGateway + Dockerで隔離されたエージェントツール）

サンドボックスの詳細：[サンドボックス](/gateway/sandboxing)

## 要件

- Docker Desktop（またはDocker Engine）+ Docker Compose v2
- イメージビルドに最低2GB RAM（`pnpm install`は1GBホストでexit 137でOOM-killされる可能性があります）
- イメージ + ログに十分なディスク容量

## コンテナ化されたGateway（Docker Compose）

### クイックスタート（推奨）

リポジトリルートから：

```bash
./docker-setup.sh
```

このスクリプトは以下を行います：

- Gatewayイメージをビルド
- オンボーディングウィザードを実行
- オプションのプロバイダーセットアップのヒントを表示
- Docker ComposeでGatewayを起動
- Gatewayトークンを生成し、`.env`に書き込み

オプションの環境変数：

- `OPENCLAW_DOCKER_APT_PACKAGES` — ビルド中に追加のaptパッケージをインストール
- `OPENCLAW_EXTRA_MOUNTS` — 追加のホストバインドマウントを追加
- `OPENCLAW_HOME_VOLUME` — 名前付きボリュームで`/home/node`を永続化

完了後：

- ブラウザで`http://127.0.0.1:18789/`を開きます。
- Control UIにトークンを貼り付けます（Settings → token）。
- URLが再度必要な場合は、`docker compose run --rm openclaw-cli dashboard --no-open`を実行してください。

ホスト上に設定/ワークスペースを書き込みます：

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPSで実行する場合は、[Hetzner（Docker VPS）](/install/hetzner)を参照してください。

### シェルヘルパー（オプション）

日常のDocker管理を簡単にするために、`ClawDock`をインストールしてください：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**シェル設定に追加（zsh）：**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

その後、`clawdock-start`、`clawdock-stop`、`clawdock-dashboard`などを使用できます。すべてのコマンドは`clawdock-help`で確認できます。

詳細は[`ClawDock`ヘルパーREADME](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md)を参照してください。

### 手動フロー（compose）

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

注意：`docker compose ...`はリポジトリルートから実行してください。
`OPENCLAW_EXTRA_MOUNTS`または`OPENCLAW_HOME_VOLUME`を有効にした場合、セットアップスクリプトが`docker-compose.extra.yml`を書き込みます。他の場所でComposeを実行する際はそれを含めてください：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UIトークン + ペアリング（Docker）

「unauthorized」または「disconnected (1008): pairing required」と表示された場合、新しいダッシュボードリンクを取得してブラウザデバイスを承認してください：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

詳細：[ダッシュボード](/web/dashboard)、[デバイス](/cli/devices)。

### 追加マウント（オプション）

コンテナに追加のホストディレクトリをマウントしたい場合は、`docker-setup.sh`を実行する前に`OPENCLAW_EXTRA_MOUNTS`を設定してください。これはカンマ区切りのDockerバインドマウントリストを受け入れ、`docker-compose.extra.yml`を生成して`openclaw-gateway`と`openclaw-cli`の両方に適用します。

例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- パスはmacOS/WindowsでDocker Desktopと共有されている必要があります。
- 各エントリは`source:target[:options]`形式で、スペース、タブ、改行なしである必要があります。
- `OPENCLAW_EXTRA_MOUNTS`を変更した場合、`docker-setup.sh`を再実行して追加のcomposeファイルを再生成してください。
- `docker-compose.extra.yml`は自動生成されます。手動で編集しないでください。

### コンテナホーム全体の永続化（オプション）

`/home/node`をコンテナの再作成後も永続化したい場合は、`OPENCLAW_HOME_VOLUME`で名前付きボリュームを設定してください。これによりDockerボリュームが作成され、`/home/node`にマウントされます（標準の設定/ワークスペースバインドマウントは維持されます）。ここでは名前付きボリュームを使用してください（バインドパスではありません）。バインドマウントには`OPENCLAW_EXTRA_MOUNTS`を使用してください。

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

注意：

- 名前付きボリュームは`^[A-Za-z0-9][A-Za-z0-9_.-]*$`に一致する必要があります。
- `OPENCLAW_HOME_VOLUME`を変更した場合、`docker-setup.sh`を再実行して追加のcomposeファイルを再生成してください。
- 名前付きボリュームは`docker volume rm <name>`で削除するまで永続化されます。

### 追加のaptパッケージのインストール（オプション）

イメージ内にシステムパッケージが必要な場合（例：ビルドツールやメディアライブラリ）、`docker-setup.sh`を実行する前に`OPENCLAW_DOCKER_APT_PACKAGES`を設定してください。これによりイメージビルド中にパッケージがインストールされ、コンテナが削除されても永続化されます。

例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意：

- スペース区切りのaptパッケージ名のリストを受け入れます。
- `OPENCLAW_DOCKER_APT_PACKAGES`を変更した場合、`docker-setup.sh`を再実行してイメージを再ビルドしてください。

### パワーユーザー / フル機能コンテナ（オプトイン）

デフォルトのDockerイメージは**セキュリティファースト**で、非rootの`node`ユーザーとして実行されます。これにより攻撃対象が小さくなりますが、以下を意味します：

- ランタイムでのシステムパッケージのインストール不可
- デフォルトでHomebrewなし
- バンドルされたChromium/Playwrightブラウザなし

より多機能なコンテナが必要な場合は、以下のオプトイン設定を使用してください：

1. **`/home/node`を永続化**して、ブラウザのダウンロードやツールキャッシュが保持されるようにします：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **システム依存関係をイメージに組み込み**（再現可能 + 永続的）：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx`なしでPlaywrightブラウザをインストール**（npmオーバーライドの競合を回避）：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Playwrightにシステム依存関係をインストールさせる必要がある場合は、ランタイムで`--with-deps`を使用する代わりに、`OPENCLAW_DOCKER_APT_PACKAGES`でイメージを再ビルドしてください。

4. **Playwrightブラウザのダウンロードを永続化**：

- `docker-compose.yml`で`PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`を設定してください。
- `OPENCLAW_HOME_VOLUME`で`/home/node`を永続化するか、`OPENCLAW_EXTRA_MOUNTS`で`/home/node/.cache/ms-playwright`をマウントしてください。

### パーミッション + EACCES

イメージは`node`（uid 1000）として実行されます。`/home/node/.openclaw`でパーミッションエラーが発生した場合、ホストのバインドマウントがuid 1000で所有されていることを確認してください。

例（Linuxホスト）：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

便宜上rootとして実行する場合は、セキュリティ上のトレードオフを受け入れることになります。

### 高速な再ビルド（推奨）

再ビルドを高速化するには、依存関係レイヤーがキャッシュされるようにDockerfileを構成してください。これにより、ロックファイルが変更されない限り`pnpm install`の再実行を回避できます：

```dockerfile
FROM node:22-bookworm

# Bunのインストール（ビルドスクリプトに必要）
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# パッケージメタデータが変更されない限り依存関係をキャッシュ
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

### チャンネルセットアップ（オプション）

CLIコンテナを使用してチャンネルを設定し、必要に応じてGatewayを再起動してください。

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

### OpenAI Codex OAuth（ヘッドレスDocker）

ウィザードでOpenAI Codex OAuthを選択すると、ブラウザURLを開き、`http://127.0.0.1:1455/auth/callback`でコールバックをキャプチャしようとします。Dockerまたはヘッドレス環境では、そのコールバックがブラウザエラーを表示する場合があります。リダイレクト先の完全なURLをコピーして、ウィザードに貼り付けて認証を完了してください。

### ヘルスチェック

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2Eスモークテスト（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### QRインポートスモークテスト（Docker）

```bash
pnpm test:docker:qr
```

### 注意事項

- Gatewayのバインドはコンテナ使用のためデフォルトで`lan`です。
- DockerfileのCMDは`--allow-unconfigured`を使用しています。`gateway.mode`が`local`でないマウント済み設定でも起動します。ガードを強制するにはCMDをオーバーライドしてください。
- Gatewayコンテナはセッションの正本です（`~/.openclaw/agents/<agentId>/sessions/`）。

## エージェントサンドボックス（ホストGateway + Dockerツール）

詳細：[サンドボックス](/gateway/sandboxing)

### 機能

`agents.defaults.sandbox`が有効な場合、**メイン以外のセッション**はDockerコンテナ内でツールを実行します。Gatewayはホスト上に残りますが、ツールの実行は隔離されます：

- スコープ：デフォルトで`"agent"`（エージェントごとに1つのコンテナ + ワークスペース）
- スコープ：セッションごとの隔離には`"session"`
- スコープごとのワークスペースフォルダが`/workspace`にマウント
- オプションのエージェントワークスペースアクセス（`agents.defaults.sandbox.workspaceAccess`）
- 許可/拒否ツールポリシー（拒否が優先）
- 受信メディアはアクティブなサンドボックスワークスペース（`media/inbound/*`）にコピーされ、ツールが読み取り可能（`workspaceAccess: "rw"`の場合、エージェントワークスペースに配置されます）

警告：`scope: "shared"`はセッション間の隔離を無効にします。すべてのセッションが1つのコンテナと1つのワークスペースを共有します。

### エージェントごとのサンドボックスプロファイル（マルチエージェント）

マルチエージェントルーティングを使用する場合、各エージェントはサンドボックス + ツール設定をオーバーライドできます：
`agents.list[].sandbox`および`agents.list[].tools`（`agents.list[].tools.sandbox.tools`も含む）。これにより、1つのGatewayで異なるアクセスレベルを実行できます：

- フルアクセス（個人エージェント）
- 読み取り専用ツール + 読み取り専用ワークスペース（家族/仕事用エージェント）
- ファイルシステム/シェルツールなし（パブリックエージェント）

例、優先順位、トラブルシューティングについては、[マルチエージェントサンドボックス&ツール](/tools/multi-agent-sandbox-tools)を参照してください。

### デフォルト動作

- イメージ：`openclaw-sandbox:bookworm-slim`
- エージェントごとに1つのコンテナ
- エージェントワークスペースアクセス：`workspaceAccess: "none"`（デフォルト）は`~/.openclaw/sandboxes`を使用
  - `"ro"`はサンドボックスワークスペースを`/workspace`に保ち、エージェントワークスペースを読み取り専用で`/agent`にマウント（`write`/`edit`/`apply_patch`を無効化）
  - `"rw"`はエージェントワークスペースを読み書き可能で`/workspace`にマウント
- 自動プルーニング：アイドル > 24時間 または 経過 > 7日
- ネットワーク：デフォルトで`none`（送信が必要な場合は明示的にオプトイン）
  - `host`はブロックされます。
  - `container:<id>`はデフォルトでブロックされます（ネームスペースジョインリスク）。
- デフォルト許可：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- デフォルト拒否：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### サンドボックスの有効化

`setupCommand`でパッケージをインストールする予定の場合は、以下に注意してください：

- デフォルトの`docker.network`は`"none"`（送信なし）です。
- `docker.network: "host"`はブロックされます。
- `docker.network: "container:<id>"`はデフォルトでブロックされます。
- 緊急時のオーバーライド：`agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`。
- `readOnlyRoot: true`はパッケージのインストールをブロックします。
- `user`は`apt-get`にはrootである必要があります（`user`を省略するか`user: "0:0"`に設定）。
  OpenClawはコンテナの`setupCommand`（またはdocker設定）が変更されると自動的にコンテナを再作成しますが、コンテナが**最近使用された**場合（約5分以内）は例外です。ホットコンテナは正確な`openclaw sandbox recreate ...`コマンドとともに警告をログに記録します。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agentがデフォルト)
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
          idleHours: 24, // 0でアイドルプルーニングを無効化
          maxAgeDays: 7, // 0で最大経過日数プルーニングを無効化
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

ハードニング設定は`agents.defaults.sandbox.docker`にあります：
`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、
`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`、
`dangerouslyAllowContainerNamespaceJoin`（緊急時のみ）。

マルチエージェント：`agents.defaults.sandbox.{docker,browser,prune}.*`をエージェントごとに`agents.list[].sandbox.{docker,browser,prune}.*`でオーバーライド
（`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope`が`"shared"`の場合は無視されます）。

### デフォルトサンドボックスイメージのビルド

```bash
scripts/sandbox-setup.sh
```

これにより`Dockerfile.sandbox`を使用して`openclaw-sandbox:bookworm-slim`がビルドされます。

### サンドボックス共通イメージ（オプション）

一般的なビルドツール（Node、Go、Rustなど）を含むサンドボックスイメージが必要な場合は、共通イメージをビルドしてください：

```bash
scripts/sandbox-common-setup.sh
```

これにより`openclaw-sandbox-common:bookworm-slim`がビルドされます。使用するには：

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### サンドボックスブラウザイメージ

サンドボックス内でブラウザツールを実行するには、ブラウザイメージをビルドしてください：

```bash
scripts/sandbox-browser-setup.sh
```

これにより`Dockerfile.sandbox-browser`を使用して`openclaw-sandbox-browser:bookworm-slim`がビルドされます。コンテナはCDPを有効にしたChromiumとオプションのnoVNCオブザーバー（Xvfb経由のヘッドフルモード）を実行します。

注意：

- ヘッドフルモード（Xvfb）はヘッドレスと比較してボット検出ブロックを軽減します。
- ヘッドレスも`agents.defaults.sandbox.browser.headless=true`を設定することで使用可能です。
- フルデスクトップ環境（GNOME）は不要です。Xvfbがディスプレイを提供します。
- ブラウザコンテナはグローバルな`bridge`ではなく、専用のDockerネットワーク（`openclaw-sandbox-browser`）をデフォルトで使用します。
- オプションの`agents.defaults.sandbox.browser.cdpSourceRange`はCIDRでコンテナエッジのCDPイングレスを制限します（例：`172.21.0.1/32`）。
- noVNCオブザーバーアクセスはデフォルトでパスワード保護されています。OpenClawはURL内の生パスワードの共有ではなく、短命のオブザーバートークンURLを提供します。

設定：

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

カスタムブラウザイメージ：

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

有効にすると、エージェントは以下を受け取ります：

- サンドボックスブラウザコントロールURL（`browser`ツール用）
- noVNC URL（有効でheadless=falseの場合）

注意：ツールの許可リストを使用している場合、`browser`を追加し（denyから削除）しないと、ツールはブロックされたままです。
プルーニングルール（`agents.defaults.sandbox.prune`）はブラウザコンテナにも適用されます。

### カスタムサンドボックスイメージ

独自のイメージをビルドし、設定でそれを指定してください：

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

### ツールポリシー（許可/拒否）

- `deny`は`allow`より優先されます。
- `allow`が空の場合：すべてのツール（deny以外）が利用可能です。
- `allow`が空でない場合：`allow`に含まれるツールのみが利用可能です（denyを除く）。

### プルーニング戦略

2つの設定項目：

- `prune.idleHours`：X時間使用されていないコンテナを削除（0 = 無効）
- `prune.maxAgeDays`：X日以上経過したコンテナを削除（0 = 無効）

例：

- ビジーなセッションを維持しつつ、有効期限を設定：
  `idleHours: 24`、`maxAgeDays: 7`
- プルーニングなし：
  `idleHours: 0`、`maxAgeDays: 0`

### セキュリティに関する注意

- ハードウォールは**ツール**（exec/read/write/edit/apply_patch）にのみ適用されます。
- ホスト専用ツール（browser/camera/canvas）はデフォルトでブロックされます。
- サンドボックスで`browser`を許可すると**隔離が破壊されます**（ブラウザはホスト上で実行されます）。

## トラブルシューティング

- イメージが見つからない：[`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)でビルドするか、`agents.defaults.sandbox.docker.image`を設定してください。
- コンテナが実行されていない：セッションごとにオンデマンドで自動作成されます。
- サンドボックスでのパーミッションエラー：`docker.user`をマウントされたワークスペースの所有権に一致するUID:GIDに設定してください（またはワークスペースフォルダのchownを実行）。
- カスタムツールが見つからない：OpenClawは`sh -lc`（ログインシェル）でコマンドを実行し、`/etc/profile`をソースしてPATHをリセットする可能性があります。`docker.env.PATH`にカスタムツールパスをプリペンドするか（例：`/custom/bin:/usr/local/share/npm-global/bin`）、Dockerfile内で`/etc/profile.d/`にスクリプトを追加してください。
