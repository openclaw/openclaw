---
summary: "OpenClaw Gateway CLI（`openclaw gateway`）— ゲートウェイの実行、クエリ、検出"
read_when:
  - CLI から Gateway を実行する場合（開発またはサーバー）
  - Gateway の認証、バインドモード、接続性をデバッグする場合
  - Bonjour（LAN + tailnet）経由でゲートウェイを検出する場合
title: "ゲートウェイ"
---

# Gateway CLI

Gateway は OpenClaw の WebSocket サーバーです（チャンネル、ノード、セッション、フック）。

このページのサブコマンドは `openclaw gateway …` 配下にあります。

関連ドキュメント:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway を実行する

ローカルの Gateway プロセスを実行します:

```bash
openclaw gateway
```

フォアグラウンドエイリアス:

```bash
openclaw gateway run
```

注記:

- 既定では、`gateway.mode=local` が `~/.openclaw/openclaw.json` に設定されていない限り、Gateway は起動を拒否します。アドホック／開発用途の実行には `--allow-unconfigured` を使用してください。 ad-hoc/dev runs には `--allow-unconfigured` を使用してください。
- 認証なしで loopback を超えてバインドすることはブロックされます（安全ガードレール）。
- `SIGUSR1` は、認可されている場合にインプロセスの再起動をトリガーします（`commands.restart` を有効にするか、gateway ツール／config の apply/update を使用してください）。
- `SIGINT`/`SIGTERM` ハンドラーはゲートウェイプロセスを停止しますが、カスタムのターミナル状態は復元しません。TUI や raw モード入力で CLI をラップしている場合は、終了前にターミナルを復元してください。 CLI を TUI または raw-mode 入力でラップする場合は、ターミナルを終了する前に復元します。

### オプション

- `--port <port>`: WebSocket ポート（既定値は config/env から取得。通常は `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`: リスナーのバインドモード。
- `--auth <token|password>`: 認証モードの上書き。
- `--token <token>`: トークンの上書き（プロセス用に `OPENCLAW_GATEWAY_TOKEN` も設定します）。
- `--password <password>`: パスワードの上書き（プロセス用に `OPENCLAW_GATEWAY_PASSWORD` も設定します）。
- `--tailscale <off|serve|funnel>`: Tailscale 経由で Gateway を公開します。
- `--tailscale-reset-on-exit`: シャットダウン時に Tailscale の serve/funnel 設定をリセットします。
- `--allow-unconfigured`: config に `gateway.mode=local` がなくても Gateway の起動を許可します。
- `--dev`: 不足している場合に dev 設定 + ワークスペースを作成します（BOOTSTRAP.md をスキップ）。
- `--reset`: dev 設定 + 資格情報 + セッション + ワークスペースをリセットします（`--dev` が必要）。
- `--force`: 起動前に選択したポートで既存のリスナーを終了します。
- `--verbose`: 詳細ログ。
- `--claude-cli-logs`: コンソールには claude-cli のログのみを表示します（stdout/stderr を有効化）。
- `--ws-log <auto|full|compact>`: websocket ログのスタイル（既定は `auto`）。
- `--compact`: `--ws-log compact` のエイリアス。
- `--raw-stream`: 生のモデルストリームイベントを jsonl に記録します。
- `--raw-stream-path <path>`: 生ストリーム jsonl のパス。

## 実行中の Gateway をクエリする

すべてのクエリコマンドは WebSocket RPC を使用します。

出力モード:

- 既定: 人間可読（TTY では色付き）。
- `--json`: 機械可読 JSON（スタイリング／スピナーなし）。
- `--no-color`（または `NO_COLOR=1`）: 人間向けレイアウトを維持したまま ANSI を無効化。

共通オプション（対応している場合）:

- `--url <url>`: Gateway の WebSocket URL。
- `--token <token>`: Gateway トークン。
- `--password <password>`: Gateway パスワード。
- `--timeout <ms>`: タイムアウト／バジェット（コマンドごとに異なります）。
- `--expect-final`: 「final」レスポンスを待機します（エージェント呼び出し）。

注記: `--url` を設定すると、CLI は config や環境の資格情報へフォールバックしません。
`--token` または `--password` を明示的に渡してください。明示的な資格情報が欠落している場合はエラーになります。
`--token` または `--password` を明示的に渡します。 明示的な資格情報が見つかりませんでした。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` は、Gateway サービス（launchd/systemd/schtasks）と、オプションの RPC プローブを表示します。

```bash
openclaw gateway status
openclaw gateway status --json
```

オプション:

- `--url <url>`: プローブ URL を上書きします。
- `--token <token>`: プローブ用のトークン認証。
- `--password <password>`: プローブ用のパスワード認証。
- `--timeout <ms>`: プローブのタイムアウト（既定は `10000`）。
- `--no-probe`: RPC プローブをスキップします（サービスのみ表示）。
- `--deep`: システムレベルのサービスもスキャンします。

### `gateway probe`

`gateway probe` は「すべてをデバッグ」するコマンドです。常に次をプローブします: それは常にプローブ:

- 設定されているリモートゲートウェイ（設定されている場合）、および
- localhost（loopback）。**リモートが設定されていても実行されます**。

複数のゲートウェイに到達可能な場合、それらのすべてを出力します。 到達可能なゲートウェイが複数ある場合は、すべてを表示します。分離されたプロファイル／ポート（例: レスキューボット）を使用すると複数ゲートウェイをサポートできますが、ほとんどのインストールでは単一のゲートウェイが稼働します。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH 経由のリモート接続（Mac アプリとの同等性）

macOS アプリの「Remote over SSH」モードはローカルのポートフォワードを使用し、loopback のみにバインドされている可能性があるリモートゲートウェイを `ws://127.0.0.1:<port>` で到達可能にします。

CLI の同等機能:

```bash
openclaw gateway probe --ssh user@gateway-host
```

オプション:

- `--ssh <target>`: `user@host` または `user@host:port`（ポートの既定は `22`）。
- `--ssh-identity <path>`: identity ファイル。
- `--ssh-auto`: 検出された最初の Gateway ホストを SSH の接続先として選択します（LAN/WAB のみ）。

設定（任意、既定値として使用）:

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低レベルの RPC ヘルパーです。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway サービスを管理する

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

注記:

- `gateway install` は `--port`、`--runtime`、`--token`、`--force`、`--json` をサポートします。
- ライフサイクルコマンドは、スクリプト向けに `--json` を受け付けます。

## ゲートウェイを検出する（Bonjour）

`gateway discover` は Gateway のビーコン（`_openclaw-gw._tcp`）をスキャンします。

- マルチキャスト DNS-SD: `local.`
- ユニキャスト DNS-SD（Wide-Area Bonjour）: ドメインを選択（例: `openclaw.internal.`）し、スプリット DNS + DNS サーバーを設定してください。[/gateway/bonjour](/gateway/bonjour) を参照してください。

Bonjour の検出が有効（既定）なゲートウェイのみがビーコンを広告します。

Wide-Area の検出レコードには次（TXT）が含まれます:

- `role`（ゲートウェイの役割ヒント）
- `transport`（トランスポートのヒント。例: `gateway`）
- `gatewayPort`（WebSocket ポート。通常は `18789`）
- `sshPort`（SSH ポート。未指定の場合の既定は `22`）
- `tailnetDns`（利用可能な場合の MagicDNS ホスト名）
- `gatewayTls` / `gatewayTlsSha256`（TLS 有効化 + 証明書フィンガープリント）
- `cliPath`（リモートインストール向けの任意ヒント）

### `gateway discover`

```bash
openclaw gateway discover
```

オプション:

- `--timeout <ms>`: コマンドごとのタイムアウト（browse/resolve）。既定は `2000`。
- `--json`: 機械可読な出力（スタイリング／スピナーも無効化）。

例:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
