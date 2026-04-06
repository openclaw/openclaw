---
read_when:
    - DockerではなくPodmanを使ったコンテナ化されたGateway ゲートウェイが欲しい場合
summary: rootlessのPodmanコンテナでOpenClawを実行する
title: Podman
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 5fb3d29b9b6c211c2f1964d4a1444030e431f3916de7e9d58831dec1632d6a34
    source_path: install/podman.md
    workflow: 15
---

# Podman

rootlessのPodmanコンテナで、現在の非rootユーザーが管理するOpenClaw Gateway ゲートウェイを実行します。

想定されるモデル：

- PodmanがGateway ゲートウェイコンテナを実行する。
- ホストの`openclaw` CLIがコントロールプレーン。
- 永続状態はデフォルトでホストの`~/.openclaw`以下に置かれる。
- 日常的な管理は`sudo -u openclaw`、`podman exec`、または別のサービスユーザーの代わりに`openclaw --container <name> ...`を使用する。

## 前提条件

- rootlessモードの**Podman**
- ホストにインストールされた**OpenClaw CLI**
- **オプション:** 自動起動のQuadlet管理が欲しい場合は`systemd --user`
- **オプション:** ヘッドレスホストでの起動時永続化のために`loginctl enable-linger "$(whoami)"`が必要な場合のみ`sudo`

## クイックスタート

<Steps>
  <Step title="初回セットアップ">
    リポジトリルートから`./scripts/podman/setup.sh`を実行。
  </Step>

  <Step title="Gateway ゲートウェイコンテナを起動">
    `./scripts/run-openclaw-podman.sh launch`でコンテナを起動。
  </Step>

  <Step title="コンテナ内でオンボーディングを実行">
    `./scripts/run-openclaw-podman.sh launch setup`を実行し、`http://127.0.0.1:18789/`を開く。
  </Step>

  <Step title="ホストCLIから実行中のコンテナを管理">
    `OPENCLAW_CONTAINER=openclaw`を設定し、ホストから通常の`openclaw`コマンドを使用。
  </Step>
</Steps>

セットアップの詳細：

- `./scripts/podman/setup.sh`はデフォルトでrootlessのPodmanストアに`openclaw:local`をビルドします。`OPENCLAW_IMAGE` / `OPENCLAW_PODMAN_IMAGE`を設定した場合はそれを使用します。
- `~/.openclaw/openclaw.json`がない場合は`gateway.mode: "local"`で作成します。
- `~/.openclaw/.env`がない場合は`OPENCLAW_GATEWAY_TOKEN`を含めて作成します。
- 手動起動の場合、ヘルパーは`~/.openclaw/.env`からPodman関連キーの小さな許可リストのみを読み込み、明示的なランタイム環境変数をコンテナに渡します。完全なenvファイルをPodmanに渡しません。

Quadlet管理のセットアップ：

```bash
./scripts/podman/setup.sh --quadlet
```

QuadletはsystemdユーザーサービスへのLinuxのみのオプションです。

`OPENCLAW_PODMAN_QUADLET=1`でも設定できます。

オプションのビルド/セットアップ環境変数：

- `OPENCLAW_IMAGE`または`OPENCLAW_PODMAN_IMAGE` -- `openclaw:local`をビルドする代わりに既存/取得済みイメージを使用
- `OPENCLAW_DOCKER_APT_PACKAGES` -- イメージビルド時に追加のaptパッケージをインストール
- `OPENCLAW_EXTENSIONS` -- ビルド時に拡張機能の依存関係を事前インストール

コンテナの起動：

```bash
./scripts/run-openclaw-podman.sh launch
```

スクリプトは現在のuid/gidで`--userns=keep-id`を付けてコンテナを起動し、OpenClawの状態をコンテナにバインドマウントします。

オンボーディング：

```bash
./scripts/run-openclaw-podman.sh launch setup
```

その後`http://127.0.0.1:18789/`を開き、`~/.openclaw/.env`のトークンを使用してください。

ホストCLIのデフォルト：

```bash
export OPENCLAW_CONTAINER=openclaw
```

その後、以下のようなコマンドが自動的にそのコンテナ内で実行されます：

```bash
openclaw dashboard --no-open
openclaw gateway status --deep
openclaw doctor
openclaw channels login
```

macOSでは、PodmanマシンによってブラウザがGateway ゲートウェイに対してローカルに見えない場合があります。
起動後にControl UIがデバイス認証エラーを報告する場合は、[Podman + Tailscale](#podman--tailscale)のガイダンスを参照してください。

<a id="podman--tailscale"></a>

## Podman + Tailscale

HTTPSまたはリモートブラウザアクセスには、メインのTailscaleドキュメントに従ってください。

Podman固有の注意：

- Podmanのpublishホストを`127.0.0.1`に保つ。
- `openclaw gateway --tailscale serve`よりホスト管理の`tailscale serve`を優先。
- macOSで、ローカルブラウザのデバイス認証コンテキストが不安定な場合、アドホックなローカルトンネルの回避策ではなくTailscaleアクセスを使用。

参照：

- [Tailscale](/gateway/tailscale)
- [Control UI](/web/control-ui)

## Systemd（Quadlet、オプション）

`./scripts/podman/setup.sh --quadlet`を実行した場合、セットアップは以下にQuadletファイルをインストールします：

```bash
~/.config/containers/systemd/openclaw.container
```

便利なコマンド：

- **起動:** `systemctl --user start openclaw.service`
- **停止:** `systemctl --user stop openclaw.service`
- **ステータス:** `systemctl --user status openclaw.service`
- **ログ:** `journalctl --user -u openclaw.service -f`

Quadletファイルを編集後：

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw.service
```

SSH/ヘッドレスホストでの起動時永続化のため、現在のユーザーのlingeringを有効化：

```bash
sudo loginctl enable-linger "$(whoami)"
```

## 設定、env、ストレージ

- **設定ディレクトリ:** `~/.openclaw`
- **ワークスペースディレクトリ:** `~/.openclaw/workspace`
- **トークンファイル:** `~/.openclaw/.env`
- **起動ヘルパー:** `./scripts/run-openclaw-podman.sh`

起動スクリプトとQuadletはホストの状態をコンテナにバインドマウントします：

- `OPENCLAW_CONFIG_DIR` -> `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR` -> `/home/node/.openclaw/workspace`

デフォルトではこれらはホストディレクトリであり、匿名のコンテナ状態ではないため、設定とワークスペースはコンテナの置き換え後も持続します。
Podmanセットアップは、ローカルダッシュボードが公開されたGateway ゲートウェイポートのコンテナの非ループバックバインドで動作するよう、`127.0.0.1`と`localhost`の`gateway.controlUi.allowedOrigins`もシードします。

手動ランチャーの便利な環境変数：

- `OPENCLAW_PODMAN_CONTAINER` -- コンテナ名（デフォルト`openclaw`）
- `OPENCLAW_PODMAN_IMAGE` / `OPENCLAW_IMAGE` -- 実行するイメージ
- `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` -- コンテナの`18789`にマップされるホストポート
- `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` -- コンテナの`18790`にマップされるホストポート
- `OPENCLAW_PODMAN_PUBLISH_HOST` -- 公開ポートのホストインターフェース; デフォルトは`127.0.0.1`
- `OPENCLAW_GATEWAY_BIND` -- コンテナ内のGateway ゲートウェイバインドモード; デフォルトは`lan`
- `OPENCLAW_PODMAN_USERNS` -- `keep-id`（デフォルト）、`auto`、または`host`

手動ランチャーはコンテナ/イメージのデフォルトを確定する前に`~/.openclaw/.env`を読み込むので、ここにこれらを保存できます。

デフォルト以外の`OPENCLAW_CONFIG_DIR`または`OPENCLAW_WORKSPACE_DIR`を使用する場合は、`./scripts/podman/setup.sh`と後の`./scripts/run-openclaw-podman.sh launch`コマンドの両方に同じ変数を設定してください。リポジトリローカルランチャーはカスタムパスの上書きをシェル間で保存しません。

Quadletの注意：

- 生成されたQuadletサービスは意図的に固定されたハードニングされたデフォルト形状を保持します：`127.0.0.1`の公開ポート、コンテナ内の`--bind lan`、および`keep-id`ユーザー名前空間。
- `OPENCLAW_GATEWAY_TOKEN`などのGateway ゲートウェイランタイム環境のために`~/.openclaw/.env`を引き続き読み込みますが、手動ランチャーのPodman固有の上書き許可リストは使用しません。
- カスタムの公開ポート、公開ホスト、またはその他のコンテナ実行フラグが必要な場合は、手動ランチャーを使用するか`~/.config/containers/systemd/openclaw.container`を直接編集してからサービスをリロードして再起動してください。

## 便利なコマンド

- **コンテナログ:** `podman logs -f openclaw`
- **コンテナを停止:** `podman stop openclaw`
- **コンテナを削除:** `podman rm -f openclaw`
- **ホストCLIからダッシュボードURLを開く:** `openclaw dashboard --no-open`
- **ホストCLI経由のヘルス/ステータス:** `openclaw gateway status --deep`

## トラブルシューティング

- **設定またはワークスペースでのパーミッション拒否（EACCES）:** コンテナはデフォルトで`--userns=keep-id`と`--user <your uid>:<your gid>`で実行されます。ホストの設定/ワークスペースパスが現在のユーザーの所有であることを確認してください。
- **Gateway ゲートウェイ起動がブロック（`gateway.mode=local`が欠けている）:** `~/.openclaw/openclaw.json`が存在して`gateway.mode="local"`が設定されていることを確認してください。`scripts/podman/setup.sh`がない場合は作成します。
- **コンテナCLIコマンドが間違ったターゲットをヒット:** `openclaw --container <name> ...`を明示的に使用するか、シェルで`OPENCLAW_CONTAINER=<name>`をエクスポートしてください。
- **`openclaw update`が`--container`で失敗:** 期待される動作です。イメージを再ビルド/取得してからコンテナまたはQuadletサービスを再起動してください。
- **Quadletサービスが起動しない:** `systemctl --user daemon-reload`を実行してから`systemctl --user start openclaw.service`。ヘッドレスシステムでは`sudo loginctl enable-linger "$(whoami)"`も必要な場合があります。
- **SELinuxがバインドマウントをブロック:** デフォルトのマウント動作はそのままにしてください。ランチャーはSELinuxが強制または許可モードの場合にLinuxで自動的に`:Z`を追加します。

## 関連

- [Docker](/install/docker)
- [Gateway ゲートウェイバックグラウンドプロセス](/gateway/background-process)
- [Gateway ゲートウェイトラブルシューティング](/gateway/troubleshooting)
