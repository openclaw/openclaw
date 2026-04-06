---
read_when:
    - ローカルインストールの代わりにコンテナ化されたGateway ゲートウェイを使いたい場合
    - Dockerフローを検証している場合
summary: OpenClawのオプションのDockerベースセットアップとオンボーディング
title: Docker
x-i18n:
    generated_at: "2026-04-02T08:33:53Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c58731f028d909ae20583fcd0553c576c07333518374acefab31e5342deb6003
    source_path: install/docker.md
    workflow: 15
---

# Docker（オプション）

Dockerは**オプション**です。コンテナ化されたGateway ゲートウェイが必要な場合、またはDockerフローを検証したい場合にのみ使用してください。

## Dockerは自分に適しているか？

- **はい**: 分離された使い捨てのGateway ゲートウェイ環境が欲しい場合、またはローカルインストールなしでホスト上でOpenClawを実行したい場合。
- **いいえ**: 自分のマシンで実行しており、最速の開発ループが欲しいだけの場合。代わりに通常のインストールフローを使用してください。
- **サンドボックスに関する注意**: エージェントのサンドボックス化もDockerを使用しますが、Gateway ゲートウェイ全体をDockerで実行する必要は**ありません**。[サンドボックス化](/gateway/sandboxing)を参照してください。

## 前提条件

- Docker Desktop（またはDocker Engine）+ Docker Compose v2
- イメージビルドに最低2 GBのRAM（1 GBのホストでは`pnpm install`がexit 137でOOMキルされる可能性があります）
- イメージとログに十分なディスク容量
- VPS/パブリックホストで実行する場合は、
  [ネットワーク公開のセキュリティ強化](/gateway/security)、
  特にDockerの`DOCKER-USER`ファイアウォールポリシーを確認してください。

## コンテナ化されたGateway ゲートウェイ

<Steps>
  <Step title="イメージのビルド">
    リポジトリルートからセットアップスクリプトを実行します:

    ```bash
    ./scripts/docker/setup.sh
    ```

    これによりGateway ゲートウェイイメージがローカルでビルドされます。代わりにビルド済みイメージを使用するには:

    ```bash
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    ビルド済みイメージは
    [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw)で公開されています。
    一般的なタグ: `main`、`latest`、`<version>`（例: `2026.2.26`）。

  </Step>

  <Step title="オンボーディングの完了">
    セットアップスクリプトはオンボーディングを自動的に実行します。以下の処理が行われます:

    - プロバイダーAPIキーの入力を促す
    - Gateway ゲートウェイトークンを生成し`.env`に書き込む
    - Docker ComposeでGateway ゲートウェイを起動する

    セットアップ中、起動前のオンボーディングと設定書き込みは
    `openclaw-gateway`を通じて直接実行されます。`openclaw-cli`はGateway ゲートウェイコンテナが既に存在する状態で実行するコマンド用です。

  </Step>

  <Step title="Control UIを開く">
    ブラウザで`http://127.0.0.1:18789/`を開き、設定にトークンを貼り付けます。

    URLが再度必要な場合:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

  </Step>

  <Step title="チャネルの設定（オプション）">
    CLIコンテナを使用してメッセージングチャネルを追加します:

    ```bash
    # WhatsApp (QR)
    docker compose run --rm openclaw-cli channels login

    # Telegram
    docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"

    # Discord
    docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
    ```

    ドキュメント: [WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

  </Step>
</Steps>

### 手動フロー

セットアップスクリプトを使用せず、各ステップを自分で実行したい場合:

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js onboard --mode local --no-install-daemon
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set gateway.mode local
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set gateway.bind lan
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set gateway.controlUi.allowedOrigins \
  '["http://localhost:18789","http://127.0.0.1:18789"]' --strict-json
docker compose up -d openclaw-gateway
```

<Note>
`docker compose`はリポジトリルートから実行してください。`OPENCLAW_EXTRA_MOUNTS`
または`OPENCLAW_HOME_VOLUME`を有効にした場合、セットアップスクリプトが`docker-compose.extra.yml`を書き出します。
`-f docker-compose.yml -f docker-compose.extra.yml`で指定してください。
</Note>

<Note>
`openclaw-cli`は`openclaw-gateway`のネットワーク名前空間を共有するため、
起動後に使用するツールです。`docker compose up -d openclaw-gateway`の前に、
オンボーディングとセットアップ時の設定書き込みは`--no-deps --entrypoint node`を付けて
`openclaw-gateway`を通じて実行してください。
</Note>

### 環境変数

セットアップスクリプトは以下のオプション環境変数を受け付けます:

| 変数                           | 用途                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `OPENCLAW_IMAGE`               | ローカルビルドの代わりにリモートイメージを使用する               |
| `OPENCLAW_DOCKER_APT_PACKAGES` | ビルド中に追加のaptパッケージをインストールする（スペース区切り） |
| `OPENCLAW_EXTENSIONS`          | ビルド時に拡張機能の依存関係を事前インストールする（スペース区切りの名前） |
| `OPENCLAW_EXTRA_MOUNTS`        | 追加のホストバインドマウント（カンマ区切り `source:target[:opts]`） |
| `OPENCLAW_HOME_VOLUME`         | `/home/node`を名前付きDockerボリュームに永続化する               |
| `OPENCLAW_SANDBOX`             | サンドボックスブートストラップを有効にする（`1`、`true`、`yes`、`on`） |
| `OPENCLAW_DOCKER_SOCKET`       | Dockerソケットパスを上書きする                                   |

### ヘルスチェック

コンテナのプローブエンドポイント（認証不要）:

```bash
curl -fsS http://127.0.0.1:18789/healthz   # liveness
curl -fsS http://127.0.0.1:18789/readyz     # readiness
```

Dockerイメージには`/healthz`にpingする組み込みの`HEALTHCHECK`が含まれています。
チェックが失敗し続けると、Dockerはコンテナを`unhealthy`としてマークし、
オーケストレーションシステムが再起動または置き換えを行えます。

認証済みの詳細ヘルススナップショット:

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### LANとloopback

`scripts/docker/setup.sh`はデフォルトで`OPENCLAW_GATEWAY_BIND=lan`を設定するため、
Dockerのポートパブリッシングで`http://127.0.0.1:18789`へのホストアクセスが機能します。

- `lan`（デフォルト）: ホストブラウザとホストCLIが公開されたGateway ゲートウェイポートに到達できます。
- `loopback`: コンテナネットワーク名前空間内のプロセスのみがGateway ゲートウェイに直接到達できます。

<Note>
`gateway.bind`にはバインドモード値（`lan` / `loopback` / `custom` /
`tailnet` / `auto`）を使用してください。`0.0.0.0`や`127.0.0.1`のようなホストエイリアスは使用しないでください。
</Note>

### ストレージと永続化

Docker Composeは`OPENCLAW_CONFIG_DIR`を`/home/node/.openclaw`に、
`OPENCLAW_WORKSPACE_DIR`を`/home/node/.openclaw/workspace`にバインドマウントするため、
これらのパスはコンテナの置き換え後も維持されます。

VMデプロイメントの永続化の詳細については、
[Docker VMランタイム - 何がどこに永続化されるか](/install/docker-vm-runtime#what-persists-where)を参照してください。

**ディスク増加のホットスポット:** `media/`、セッションJSONLファイル、`cron/runs/*.jsonl`、
および`/tmp/openclaw/`配下のローリングファイルログに注意してください。

### シェルヘルパー（オプション）

日常的なDocker管理を簡単にするために、`ClawDock`をインストールします:

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

以前の`scripts/shell-helpers/clawdock-helpers.sh`のrawパスからClawDockをインストールした場合は、上記のインストールコマンドを再実行して、ローカルヘルパーファイルが新しい場所を追跡するようにしてください。

その後、`clawdock-start`、`clawdock-stop`、`clawdock-dashboard`などを使用します。
すべてのコマンドは`clawdock-help`を実行して確認してください。
完全なヘルパーガイドは[ClawDock](/install/clawdock)を参照してください。

<AccordionGroup>
  <Accordion title="DockerのGateway ゲートウェイでエージェントサンドボックスを有効にする">
    ```bash
    export OPENCLAW_SANDBOX=1
    ./scripts/docker/setup.sh
    ```

    カスタムソケットパス（例: rootless Docker）:

    ```bash
    export OPENCLAW_SANDBOX=1
    export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
    ./scripts/docker/setup.sh
    ```

    スクリプトはサンドボックスの前提条件が通過した後にのみ`docker.sock`をマウントします。
    サンドボックスのセットアップが完了できない場合、スクリプトは`agents.defaults.sandbox.mode`
    を`off`にリセットします。

  </Accordion>

  <Accordion title="自動化 / CI（非対話型）">
    `-T`でCompose疑似TTY割り当てを無効にします:

    ```bash
    docker compose run -T --rm openclaw-cli gateway probe
    docker compose run -T --rm openclaw-cli devices list --json
    ```

  </Accordion>

  <Accordion title="共有ネットワークのセキュリティに関する注意">
    `openclaw-cli`は`network_mode: "service:openclaw-gateway"`を使用するため、
    CLIコマンドは`127.0.0.1`経由でGateway ゲートウェイに到達できます。これを共有信頼境界として
    扱ってください。compose設定は`openclaw-cli`で`NET_RAW`/`NET_ADMIN`をドロップし、
    `no-new-privileges`を有効にしています。
  </Accordion>

  <Accordion title="パーミッションとEACCES">
    イメージは`node`（uid 1000）として実行されます。
    `/home/node/.openclaw`でパーミッションエラーが発生する場合、ホストのバインドマウントがuid 1000の所有になっていることを確認してください:

    ```bash
    sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
    ```

  </Accordion>

  <Accordion title="高速リビルド">
    依存関係レイヤーがキャッシュされるようにDockerfileを整理してください。これにより
    ロックファイルが変更されない限り`pnpm install`の再実行を回避できます:

    ```dockerfile
    FROM node:24-bookworm
    RUN curl -fsSL https://bun.sh/install | bash
    ENV PATH="/root/.bun/bin:${PATH}"
    RUN corepack enable
    WORKDIR /app
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

  </Accordion>

  <Accordion title="パワーユーザー向けコンテナオプション">
    デフォルトイメージはセキュリティ重視で、非rootの`node`として実行されます。より
    フル機能のコンテナにするには:

    1. **`/home/node`の永続化**: `export OPENCLAW_HOME_VOLUME="openclaw_home"`
    2. **システム依存関係の組み込み**: `export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"`
    3. **Playwrightブラウザのインストール**:
       ```bash
       docker compose run --rm openclaw-cli \
         node /app/node_modules/playwright-core/cli.js install chromium
       ```
    4. **ブラウザダウンロードの永続化**: 
       `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`を設定し、
       `OPENCLAW_HOME_VOLUME`または`OPENCLAW_EXTRA_MOUNTS`を使用してください。

  </Accordion>

  <Accordion title="OpenAI Codex OAuth（ヘッドレスDocker）">
    ウィザードでOpenAI Codex OAuthを選択すると、ブラウザURLが開きます。
    Dockerまたはヘッドレス環境では、リダイレクト先の完全なURLをコピーして
    ウィザードに貼り付けて認証を完了してください。
  </Accordion>

  <Accordion title="ベースイメージのメタデータ">
    メインDockerイメージは`node:24-bookworm`を使用し、
    `org.opencontainers.image.base.name`、
    `org.opencontainers.image.source`などのOCIベースイメージアノテーションを公開しています。
    [OCIイメージアノテーション](https://github.com/opencontainers/image-spec/blob/main/annotations.md)を参照してください。
  </Accordion>
</AccordionGroup>

### VPSで実行する場合

[Hetzner（Docker VPS）](/install/hetzner)および
[Docker VMランタイム](/install/docker-vm-runtime)で、バイナリベイク、永続化、
アップデートを含む共有VMデプロイメント手順を参照してください。

## エージェントサンドボックス

`agents.defaults.sandbox`が有効な場合、Gateway ゲートウェイはエージェントのツール実行
（シェル、ファイル読み書きなど）を分離されたDockerコンテナ内で実行し、
Gateway ゲートウェイ自体はホスト上に留まります。これにより、Gateway ゲートウェイ全体を
コンテナ化することなく、信頼されていないまたはマルチテナントのエージェントセッションに
対してハードウォールを設けることができます。

サンドボックスのスコープはエージェント単位（デフォルト）、セッション単位、または共有に設定できます。各スコープには
`/workspace`にマウントされた独自のワークスペースがあります。また、許可/拒否ツールポリシー、
ネットワーク分離、リソース制限、ブラウザコンテナも設定できます。

完全な設定、イメージ、セキュリティノート、マルチエージェントプロファイルについては以下を参照してください:

- [サンドボックス化](/gateway/sandboxing) -- 完全なサンドボックスリファレンス
- [OpenShell](/gateway/openshell) -- サンドボックスコンテナへの対話型シェルアクセス
- [マルチエージェントサンドボックスとツール](/tools/multi-agent-sandbox-tools) -- エージェント単位のオーバーライド

### クイック有効化

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
      },
    },
  },
}
```

デフォルトのサンドボックスイメージをビルドします:

```bash
scripts/sandbox-setup.sh
```

## トラブルシューティング

<AccordionGroup>
  <Accordion title="イメージが見つからない、またはサンドボックスコンテナが起動しない">
    [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)
    でサンドボックスイメージをビルドするか、`agents.defaults.sandbox.docker.image`に
    カスタムイメージを設定してください。
    コンテナはセッションごとにオンデマンドで自動作成されます。
  </Accordion>

  <Accordion title="サンドボックスでのパーミッションエラー">
    マウントされたワークスペースの所有権と一致するUID:GIDを`docker.user`に設定するか、
    ワークスペースフォルダのchownを行ってください。
  </Accordion>

  <Accordion title="サンドボックスでカスタムツールが見つからない">
    OpenClawは`sh -lc`（ログインシェル）でコマンドを実行し、
    `/etc/profile`を読み込んでPATHをリセットする場合があります。`docker.env.PATH`を設定して
    カスタムツールパスを先頭に追加するか、Dockerfileの`/etc/profile.d/`にスクリプトを追加してください。
  </Accordion>

  <Accordion title="イメージビルド中にOOMキル（exit 137）">
    VMには最低2 GBのRAMが必要です。より大きなマシンクラスを使用して再試行してください。
  </Accordion>

  <Accordion title="Control UIで未認証またはペアリングが必要">
    新しいダッシュボードリンクを取得し、ブラウザデバイスを承認します:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    詳細: [ダッシュボード](/web/dashboard)、[デバイス](/cli/devices)。

  </Accordion>

  <Accordion title="Gateway ゲートウェイのターゲットがws://172.x.x.xと表示される、またはDocker CLIからペアリングエラーが出る">
    Gateway ゲートウェイモードとバインドをリセットします:

    ```bash
    docker compose run --rm openclaw-cli config set gateway.mode local
    docker compose run --rm openclaw-cli config set gateway.bind lan
    docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
    ```

  </Accordion>
</AccordionGroup>

## 関連

- [インストール概要](/install) — すべてのインストール方法
- [Podman](/install/podman) — Dockerの代替としてのPodman
- [ClawDock](/install/clawdock) — Docker Composeコミュニティセットアップ
- [アップデート](/install/updating) — OpenClawを最新に保つ
- [設定](/gateway/configuration) — インストール後のGateway ゲートウェイ設定
