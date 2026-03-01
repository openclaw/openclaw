---
summary: "OpenClaw Gateway CLI（`openclaw gateway`）- Gatewayの実行、クエリ、およびディスカバリー"
read_when:
  - CLIからGatewayを実行する場合（開発またはサーバー）
  - Gateway認証、バインドモード、接続性をデバッグする場合
  - Bonjour（LAN + tailnet）経由でGatewayをディスカバリーする場合
title: "gateway"
---

# Gateway CLI

GatewayはOpenClawのWebSocketサーバーです（チャネル、ノード、セッション、フック）。

このページのサブコマンドは `openclaw gateway ...` の下にあります。

関連ドキュメント：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gatewayの実行

ローカルGatewayプロセスを実行します：

```bash
openclaw gateway
```

フォアグラウンドエイリアス：

```bash
openclaw gateway run
```

注意事項：

- デフォルトでは、`~/.openclaw/openclaw.json` に `gateway.mode=local` が設定されていないとGatewayの起動を拒否します。アドホック/開発での実行には `--allow-unconfigured` を使用してください。
- 認証なしでループバック以外にバインドすることはブロックされます（安全ガードレール）。
- `SIGUSR1` は認可された場合にプロセス内再起動をトリガーします（`commands.restart` はデフォルトで有効です。手動再起動をブロックするには `commands.restart: false` を設定しますが、Gatewayツール/設定適用/更新は引き続き許可されます）。
- `SIGINT`/`SIGTERM` ハンドラーはGatewayプロセスを停止しますが、カスタムターミナル状態は復元しません。CLIをTUIまたは生モード入力でラップする場合は、終了前にターミナルを復元してください。

### オプション

- `--port <port>`: WebSocketポート（デフォルトは設定/環境から取得、通常 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`: リスナーバインドモード。
- `--auth <token|password>`: 認証モードの上書き。
- `--token <token>`: トークンの上書き（プロセスの `OPENCLAW_GATEWAY_TOKEN` も設定します）。
- `--password <password>`: パスワードの上書き（プロセスの `OPENCLAW_GATEWAY_PASSWORD` も設定します）。
- `--tailscale <off|serve|funnel>`: Tailscale経由でGatewayを公開します。
- `--tailscale-reset-on-exit`: シャットダウン時にTailscaleのserve/funnel設定をリセットします。
- `--allow-unconfigured`: 設定に `gateway.mode=local` がなくてもGatewayの起動を許可します。
- `--dev`: 存在しない場合、開発用設定 + ワークスペースを作成します（BOOTSTRAP.mdをスキップ）。
- `--reset`: 開発用設定 + 資格情報 + セッション + ワークスペースをリセットします（`--dev` が必要）。
- `--force`: 起動前に選択したポートの既存リスナーを終了します。
- `--verbose`: 詳細ログ。
- `--claude-cli-logs`: コンソールにclaude-cliログのみ表示します（stdout/stderrも有効化）。
- `--ws-log <auto|full|compact>`: WebSocketログスタイル（デフォルト `auto`）。
- `--compact`: `--ws-log compact` のエイリアス。
- `--raw-stream`: 生のモデルストリームイベントをjsonlにログ出力します。
- `--raw-stream-path <path>`: 生ストリームjsonlのパス。

## 実行中のGatewayへのクエリ

すべてのクエリコマンドはWebSocket RPCを使用します。

出力モード：

- デフォルト：人間可読（TTYではカラー表示）。
- `--json`: 機械可読JSON（スタイリング/スピナーなし）。
- `--no-color`（または `NO_COLOR=1`）：人間可読レイアウトを維持しつつANSIを無効化。

共有オプション（サポートされている場合）：

- `--url <url>`: Gateway WebSocket URL。
- `--token <token>`: Gatewayトークン。
- `--password <password>`: Gatewayパスワード。
- `--timeout <ms>`: タイムアウト/バジェット（コマンドにより異なる）。
- `--expect-final`: 「final」レスポンスを待機します（エージェント呼び出し）。

注意：`--url` を設定すると、CLIは設定や環境変数の資格情報にフォールバックしません。
`--token` または `--password` を明示的に渡してください。明示的な資格情報がない場合はエラーになります。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` はGatewayサービス（launchd/systemd/schtasks）とオプションのRPCプローブを表示します。

```bash
openclaw gateway status
openclaw gateway status --json
```

オプション：

- `--url <url>`: プローブURLの上書き。
- `--token <token>`: プローブのトークン認証。
- `--password <password>`: プローブのパスワード認証。
- `--timeout <ms>`: プローブタイムアウト（デフォルト `10000`）。
- `--no-probe`: RPCプローブをスキップ（サービスのみ表示）。
- `--deep`: システムレベルのサービスもスキャンします。

### `gateway probe`

`gateway probe` は「すべてをデバッグ」するコマンドです。常にプローブするのは：

- 設定済みのリモートGateway（設定されている場合）、および
- リモートが設定されていても **localhost（ループバック）**。

複数のGatewayが到達可能な場合、すべてを表示します。分離されたプロファイル/ポートを使用する場合（例：レスキューボット）、複数のGatewayがサポートされますが、ほとんどのインストールでは単一のGatewayを実行します。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH経由のリモート（Macアプリと同等）

macOSアプリの「Remote over SSH」モードは、ローカルポートフォワードを使用してリモートGateway（ループバックのみにバインドされている可能性がある）が `ws://127.0.0.1:<port>` で到達可能になります。

CLI相当：

```bash
openclaw gateway probe --ssh user@gateway-host
```

オプション：

- `--ssh <target>`: `user@host` または `user@host:port`（ポートのデフォルトは `22`）。
- `--ssh-identity <path>`: アイデンティティファイル。
- `--ssh-auto`: 最初に発見されたGatewayホストをSSHターゲットとして選択します（LAN/WABのみ）。

設定（オプション、デフォルトとして使用）：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低レベルRPCヘルパーです。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gatewayサービスの管理

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

注意事項：

- `gateway install` は `--port`、`--runtime`、`--token`、`--force`、`--json` をサポートします。
- ライフサイクルコマンドはスクリプティング用に `--json` を受け付けます。

## Gatewayのディスカバリー（Bonjour）

`gateway discover` はGatewayビーコン（`_openclaw-gw._tcp`）をスキャンします。

- マルチキャストDNS-SD: `local.`
- ユニキャストDNS-SD（広域Bonjour）: ドメインを選択（例：`openclaw.internal.`）してスプリットDNS + DNSサーバーをセットアップします。[/gateway/bonjour](/gateway/bonjour)を参照

Bonjourディスカバリーが有効（デフォルト）なGatewayのみがビーコンをアドバタイズします。

広域ディスカバリーレコードに含まれるもの（TXT）：

- `role`（Gatewayロールヒント）
- `transport`（トランスポートヒント、例：`gateway`）
- `gatewayPort`（WebSocketポート、通常 `18789`）
- `sshPort`（SSHポート、存在しない場合のデフォルトは `22`）
- `tailnetDns`（MagicDNSホスト名、利用可能な場合）
- `gatewayTls` / `gatewayTlsSha256`（TLS有効 + 証明書フィンガープリント）
- `cliPath`（リモートインストール用のオプションヒント）

### `gateway discover`

```bash
openclaw gateway discover
```

オプション：

- `--timeout <ms>`: コマンドごとのタイムアウト（browse/resolve）、デフォルト `2000`。
- `--json`: 機械可読出力（スタイリング/スピナーも無効化）。

使用例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
