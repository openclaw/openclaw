---
read_when:
    - CLIからGateway ゲートウェイを実行する場合（開発またはサーバー）
    - Gateway ゲートウェイの認証、バインドモード、接続性のデバッグ
    - Bonjour経由でGateway ゲートウェイをディスカバリーする（LAN + tailnet）
summary: OpenClaw Gateway ゲートウェイ CLI（`openclaw gateway`）— Gateway ゲートウェイの実行、クエリ、ディスカバリー
title: gateway
x-i18n:
    generated_at: "2026-04-02T07:34:34Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8ce977a4e7fa7c4b829f85a1c49d192c95aa393a3caa805b3bd1adca73234364
    source_path: cli/gateway.md
    workflow: 15
---

# Gateway ゲートウェイ CLI

Gateway ゲートウェイはOpenClawのWebSocketサーバーです（チャネル、ノード、セッション、フック）。

このページのサブコマンドは `openclaw gateway …` 配下にあります。

関連ドキュメント：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway ゲートウェイの実行

ローカルのGateway ゲートウェイプロセスを実行します：

```bash
openclaw gateway
```

フォアグラウンドエイリアス：

```bash
openclaw gateway run
```

注意事項：

- デフォルトでは、`~/.openclaw/openclaw.json` に `gateway.mode=local` が設定されていない限り、Gateway ゲートウェイは起動を拒否します。アドホック/開発実行には `--allow-unconfigured` を使用してください。
- 認証なしでloopback以外にバインドすることはブロックされます（安全ガードレール）。
- `SIGUSR1` は認可時にプロセス内再起動をトリガーします（`commands.restart` はデフォルトで有効です。手動再起動をブロックするには `commands.restart: false` を設定してください。Gateway ゲートウェイのツール/設定の適用/更新は引き続き許可されます）。
- `SIGINT`/`SIGTERM` ハンドラーはGateway ゲートウェイプロセスを停止しますが、カスタムターミナル状態を復元しません。CLIをTUIやraw-mode入力でラップしている場合は、終了前にターミナルを復元してください。

### オプション

- `--port <port>`：WebSocketポート（デフォルトは設定/環境変数から取得。通常は `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`：リスナーバインドモード。
- `--auth <token|password>`：認証モードのオーバーライド。
- `--token <token>`：トークンのオーバーライド（プロセスに `OPENCLAW_GATEWAY_TOKEN` も設定されます）。
- `--password <password>`：パスワードのオーバーライド。警告：インラインパスワードはローカルのプロセスリストに公開される可能性があります。
- `--password-file <path>`：ファイルからGateway ゲートウェイのパスワードを読み取ります。
- `--tailscale <off|serve|funnel>`：Tailscale経由でGateway ゲートウェイを公開します。
- `--tailscale-reset-on-exit`：シャットダウン時にTailscaleのserve/funnel設定をリセットします。
- `--allow-unconfigured`：設定に `gateway.mode=local` がなくてもGateway ゲートウェイの起動を許可します。
- `--dev`：開発用設定とワークスペースが存在しない場合に作成します（BOOTSTRAP.mdをスキップ）。
- `--reset`：開発用設定、認証情報、セッション、ワークスペースをリセットします（`--dev` が必要）。
- `--force`：起動前に選択したポートの既存リスナーを強制終了します。
- `--verbose`：詳細ログ。
- `--cli-backend-logs`：コンソールにCLIバックエンドログのみを表示します（stdout/stderrを有効にします）。
- `--claude-cli-logs`：`--cli-backend-logs` の非推奨エイリアス。
- `--ws-log <auto|full|compact>`：WebSocketログスタイル（デフォルト `auto`）。
- `--compact`：`--ws-log compact` のエイリアス。
- `--raw-stream`：rawモデルストリームイベントをjsonlにログ出力します。
- `--raw-stream-path <path>`：rawストリームのjsonlパス。

## 実行中のGateway ゲートウェイへのクエリ

すべてのクエリコマンドはWebSocket RPCを使用します。

出力モード：

- デフォルト：人間が読みやすい形式（TTYではカラー表示）。
- `--json`：機械可読なJSON（スタイリング/スピナーなし）。
- `--no-color`（または `NO_COLOR=1`）：人間用レイアウトを維持しつつANSIを無効化。

共通オプション（サポートされている場合）：

- `--url <url>`：Gateway ゲートウェイのWebSocket URL。
- `--token <token>`：Gateway ゲートウェイのトークン。
- `--password <password>`：Gateway ゲートウェイのパスワード。
- `--timeout <ms>`：タイムアウト/バジェット（コマンドによって異なります）。
- `--expect-final`：「final」レスポンスを待ちます（エージェント呼び出し）。

注意：`--url` を設定した場合、CLIは設定や環境変数の認証情報にフォールバックしません。
`--token` または `--password` を明示的に渡してください。明示的な認証情報がない場合はエラーになります。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` はGateway ゲートウェイサービス（launchd/systemd/schtasks）と、オプションのRPCプローブを表示します。

```bash
openclaw gateway status
openclaw gateway status --json
openclaw gateway status --require-rpc
```

オプション：

- `--url <url>`：プローブURLのオーバーライド。
- `--token <token>`：プローブのトークン認証。
- `--password <password>`：プローブのパスワード認証。
- `--timeout <ms>`：プローブタイムアウト（デフォルト `10000`）。
- `--no-probe`：RPCプローブをスキップ（サービスのみのビュー）。
- `--deep`：システムレベルのサービスもスキャン。
- `--require-rpc`：RPCプローブが失敗した場合にゼロ以外で終了。`--no-probe` と併用できません。

注意事項：

- `gateway status` は可能な場合、プローブ認証のために設定済みの認証SecretRefを解決します。
- このコマンドパスで必要な認証SecretRefが未解決の場合、`gateway status --json` はプローブの接続/認証が失敗した際に `rpc.authWarning` を報告します。`--token`/`--password` を明示的に渡すか、先にシークレットソースを解決してください。
- プローブが成功した場合、誤検知を避けるために未解決の認証ref警告は抑制されます。
- スクリプトや自動化では、リスニングサービスだけでは不十分でGateway ゲートウェイRPC自体が正常である必要がある場合に `--require-rpc` を使用してください。
- Linux systemdインストールでは、サービス認証ドリフトチェックがユニットから `Environment=` と `EnvironmentFile=` の両方の値を読み取ります（`%h`、クォートされたパス、複数ファイル、オプションの `-` ファイルを含む）。
- ドリフトチェックはマージされたランタイム環境（サービスコマンド環境を優先し、次にプロセス環境にフォールバック）を使用して `gateway.auth.token` のSecretRefを解決します。
- トークン認証が実質的にアクティブでない場合（`gateway.auth.mode` が明示的に `password`/`none`/`trusted-proxy` に設定されている、またはモード未設定でパスワードが優先されトークン候補が存在しない場合）、トークンドリフトチェックは設定トークンの解決をスキップします。

### `gateway probe`

`gateway probe` は「すべてをデバッグする」コマンドです。常に以下をプローブします：

- 設定済みのリモートGateway ゲートウェイ（設定されている場合）、および
- リモートが設定されていても **localhost（loopback）**。

複数のGateway ゲートウェイが到達可能な場合、すべてを出力します。分離されたプロファイル/ポートを使用する場合（例：レスキューボット）は複数のGateway ゲートウェイがサポートされますが、ほとんどのインストールでは単一のGateway ゲートウェイを実行します。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

解釈：

- `Reachable: yes` は、少なくとも1つのターゲットがWebSocket接続を受け入れたことを意味します。
- `RPC: ok` は、詳細RPCコール（`health`/`status`/`system-presence`/`config.get`）も成功したことを意味します。
- `RPC: limited - missing scope: operator.read` は、接続は成功したが詳細RPCのスコープが制限されていることを意味します。これは完全な失敗ではなく、**degraded（劣化）** 到達可能性として報告されます。
- 終了コードは、プローブされたターゲットがどれも到達不能な場合にのみゼロ以外になります。

JSONの注意事項（`--json`）：

- トップレベル：
  - `ok`：少なくとも1つのターゲットが到達可能。
  - `degraded`：少なくとも1つのターゲットでスコープ制限された詳細RPC。
- ターゲットごと（`targets[].connect`）：
  - `ok`：接続 + degraded分類後の到達可能性。
  - `rpcOk`：完全な詳細RPCの成功。
  - `scopeLimited`：オペレータースコープの不足により詳細RPCが失敗。

#### SSH経由のリモート（Macアプリ同等）

macOSアプリの「Remote over SSH」モードはローカルポートフォワードを使用し、リモートGateway ゲートウェイ（loopbackのみにバインドされている場合がある）が `ws://127.0.0.1:<port>` で到達可能になります。

CLI同等のコマンド：

```bash
openclaw gateway probe --ssh user@gateway-host
```

オプション：

- `--ssh <target>`：`user@host` または `user@host:port`（ポートのデフォルトは `22`）。
- `--ssh-identity <path>`：IDファイル。
- `--ssh-auto`：検出された最初のGateway ゲートウェイホストをSSHターゲットとして選択（LAN/WABのみ）。

設定（オプション、デフォルトとして使用）：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低レベルRPCヘルパー。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway ゲートウェイサービスの管理

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

注意事項：

- `gateway install` は `--port`、`--runtime`、`--token`、`--force`、`--json` をサポートします。
- トークン認証がトークンを必要とし、`gateway.auth.token` がSecretRef管理されている場合、`gateway install` はSecretRefが解決可能であることを検証しますが、解決されたトークンをサービス環境メタデータに永続化しません。
- トークン認証がトークンを必要とし、設定されたトークンのSecretRefが未解決の場合、フォールバックの平文を永続化する代わりにクローズドで失敗します。
- `gateway run` でのパスワード認証には、インラインの `--password` よりも `OPENCLAW_GATEWAY_PASSWORD`、`--password-file`、またはSecretRefベースの `gateway.auth.password` を推奨します。
- 推定認証モードでは、シェルのみの `OPENCLAW_GATEWAY_PASSWORD` はインストール時のトークン要件を緩和しません。管理サービスをインストールする場合は、永続的な設定（`gateway.auth.password` または設定の `env`）を使用してください。
- `gateway.auth.token` と `gateway.auth.password` の両方が設定されており、`gateway.auth.mode` が未設定の場合、モードが明示的に設定されるまでインストールはブロックされます。
- ライフサイクルコマンドはスクリプティング用に `--json` を受け付けます。

## Gateway ゲートウェイのディスカバリー（Bonjour）

`gateway discover` はGateway ゲートウェイビーコン（`_openclaw-gw._tcp`）をスキャンします。

- マルチキャストDNS-SD：`local.`
- ユニキャストDNS-SD（Wide-Area Bonjour）：ドメインを選択し（例：`openclaw.internal.`）、スプリットDNS + DNSサーバーを設定してください。[/gateway/bonjour](/gateway/bonjour) を参照

Bonjourディスカバリーが有効（デフォルト）なGateway ゲートウェイのみがビーコンをアドバタイズします。

Wide-Areaディスカバリーレコードに含まれる情報（TXT）：

- `role`（Gateway ゲートウェイロールヒント）
- `transport`（トランスポートヒント、例：`gateway`）
- `gatewayPort`（WebSocketポート、通常 `18789`）
- `sshPort`（SSHポート、存在しない場合はデフォルト `22`）
- `tailnetDns`（MagicDNSホスト名、利用可能な場合）
- `gatewayTls` / `gatewayTlsSha256`（TLS有効 + 証明書フィンガープリント）
- `cliPath`（リモートインストール用のオプションヒント）

### `gateway discover`

```bash
openclaw gateway discover
```

オプション：

- `--timeout <ms>`：コマンドごとのタイムアウト（browse/resolve）、デフォルト `2000`。
- `--json`：機械可読な出力（スタイリング/スピナーも無効化）。

例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
