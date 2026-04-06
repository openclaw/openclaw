---
read_when:
    - iOS/AndroidノードをGateway ゲートウェイにペアリングする
    - エージェントコンテキストにノードのcanvas/カメラを使用する
    - 新しいノードコマンドやCLIヘルパーを追加する
summary: 'ノード: ペアリング、機能、権限、canvas/カメラ/画面/デバイス/通知/システムのCLIヘルパー'
title: ノード
x-i18n:
    generated_at: "2026-04-02T07:47:25Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9bc6494e7551b603f9dc1157b223d4694d656c5dd3e04f6f6bb5e5300e0e63c7
    source_path: nodes/index.md
    workflow: 15
---

# ノード

**ノード**は、Gateway ゲートウェイの**WebSocket**（オペレーターと同じポート）に `role: "node"` で接続し、`node.invoke` を通じてコマンドサーフェス（例: `canvas.*`、`camera.*`、`device.*`、`notifications.*`、`system.*`）を公開するコンパニオンデバイス（macOS/iOS/Android/ヘッドレス）です。プロトコルの詳細: [Gateway ゲートウェイプロトコル](/gateway/protocol)。

レガシートランスポート: [ブリッジプロトコル](/gateway/bridge-protocol)（TCP JSONL; 現在のノードでは非推奨/削除済み）。

macOSは**ノードモード**でも動作可能です: メニューバーアプリがGateway ゲートウェイのWSサーバーに接続し、ローカルのcanvas/カメラコマンドをノードとして公開します（そのため `openclaw nodes …` がこのMacに対して動作します）。

注意事項:

- ノードは**周辺機器**であり、Gateway ゲートウェイではありません。Gateway ゲートウェイサービスを実行しません。
- Telegram/WhatsApp等のメッセージは**Gateway ゲートウェイ**に届き、ノードには届きません。
- トラブルシューティングランブック: [/nodes/troubleshooting](/nodes/troubleshooting)

## ペアリング + ステータス

**WSノードはデバイスペアリングを使用します。** ノードは `connect` 時にデバイスIDを提示し、Gateway ゲートウェイが `role: node` のデバイスペアリングリクエストを作成します。デバイスCLI（またはUI）で承認してください。

クイックCLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

ノードが認証情報（ロール/スコープ/公開鍵）を変更してリトライした場合、以前の保留中のリクエストは置き換えられ、新しい `requestId` が作成されます。承認前に `openclaw devices list` を再実行してください。

注意事項:

- `nodes status` は、デバイスペアリングロールに `node` が含まれている場合、ノードを**ペアリング済み**と表示します。
- `node.pair.*`（CLI: `openclaw nodes pending/approve/reject`）は、Gateway ゲートウェイが所有する別のノードペアリングストアです。WSの `connect` ハンドシェイクを制御する**ものではありません**。

## リモートノードホスト（system.run）

Gateway ゲートウェイが1台のマシンで動作し、コマンドを別のマシンで実行したい場合は、**ノードホスト**を使用します。モデルは引き続き**Gateway ゲートウェイ**と通信し、`host=node` が選択された場合、Gateway ゲートウェイが `exec` コールを**ノードホスト**に転送します。

### 実行場所

- **Gateway ゲートウェイホスト**: メッセージを受信し、モデルを実行し、ツールコールをルーティングします。
- **ノードホスト**: ノードマシン上で `system.run`/`system.which` を実行します。
- **承認**: ノードホスト上の `~/.openclaw/exec-approvals.json` で強制されます。

承認に関する注意:

- 承認付きノード実行は、正確なリクエストコンテキストにバインドされます。
- 直接的なシェル/ランタイムファイル実行の場合、OpenClawはベストエフォートで1つの具体的なローカルファイルオペランドもバインドし、実行前にそのファイルが変更された場合は実行を拒否します。
- インタープリター/ランタイムコマンドに対して正確に1つの具体的なローカルファイルをOpenClawが特定できない場合、完全なランタイムカバレッジを偽装するのではなく、承認付き実行が拒否されます。より広範なインタープリターセマンティクスには、サンドボックス化、別のホスト、または明示的な信頼済み許可リスト/完全なワークフローを使用してください。

### ノードホストの起動（フォアグラウンド）

ノードマシン上で:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSHトンネル経由のリモートGateway ゲートウェイ（local loopbackバインド）

Gateway ゲートウェイがlocal loopbackにバインドしている場合（`gateway.bind=loopback`、ローカルモードのデフォルト）、リモートノードホストは直接接続できません。SSHトンネルを作成し、ノードホストをトンネルのローカル側に向けてください。

例（ノードホスト -> Gateway ゲートウェイホスト）:

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注意事項:

- `openclaw node run` はトークンまたはパスワード認証をサポートしています。
- 環境変数が推奨されます: `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`。
- 設定のフォールバックは `gateway.auth.token` / `gateway.auth.password` です。
- ローカルモードでは、ノードホストは意図的に `gateway.remote.token` / `gateway.remote.password` を無視します。
- リモートモードでは、`gateway.remote.token` / `gateway.remote.password` がリモート優先ルールに従って使用可能です。
- アクティブなローカル `gateway.auth.*` SecretRefが設定されているが未解決の場合、ノードホスト認証はクローズドで失敗します。
- ノードホスト認証の解決は `OPENCLAW_GATEWAY_*` 環境変数のみを使用します。

### ノードホストの起動（サービス）

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### ペアリング + 命名

Gateway ゲートウェイホスト上で:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

ノードが認証情報を変更してリトライした場合、`openclaw devices list` を再実行して現在の `requestId` を承認してください。

命名オプション:

- `openclaw node run` / `openclaw node install` で `--display-name` を指定（ノード上の `~/.openclaw/node.json` に保存されます）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（Gateway ゲートウェイのオーバーライド）。

### コマンドの許可リスト設定

exec承認は**ノードホストごと**です。Gateway ゲートウェイから許可リストエントリを追加します:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

承認はノードホスト上の `~/.openclaw/exec-approvals.json` に保存されます。

### execをノードに向ける

デフォルトの設定（Gateway ゲートウェイ設定）:

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

またはセッションごとに:

```
/exec host=node security=allowlist node=<id-or-name>
```

設定後、`host=node` を指定した `exec` コールはすべてノードホスト上で実行されます（ノードの許可リスト/承認に従います）。

関連:

- [ノードホストCLI](/cli/node)
- [execツール](/tools/exec)
- [exec承認](/tools/exec-approvals)

## コマンドの呼び出し

低レベル（生のRPC）:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

一般的な「エージェントにMEDIA添付ファイルを渡す」ワークフロー用に、より高レベルなヘルパーが存在します。

## スクリーンショット（canvasスナップショット）

ノードがCanvas（WebView）を表示している場合、`canvas.snapshot` は `{ format, base64 }` を返します。

CLIヘルパー（一時ファイルに書き込み、`MEDIA:<path>` を出力します）:

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvasコントロール

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意事項:

- `canvas present` はURLまたはローカルファイルパス（`--target`）を受け付け、オプションで `--x/--y/--width/--height` による位置指定が可能です。
- `canvas eval` はインラインJS（`--js`）または位置引数を受け付けます。

### A2UI（Canvas）

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意事項:

- A2UI v0.8 JSONLのみサポートされています（v0.9/createSurfaceは拒否されます）。

## 写真 + 動画（ノードカメラ）

写真（`jpg`）:

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

動画クリップ（`mp4`）:

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意事項:

- `canvas.*` および `camera.*` を使用するには、ノードが**フォアグラウンド**である必要があります（バックグラウンドからの呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します）。
- クリップの長さは制限されています（現在 `<= 60s`）。base64ペイロードの肥大化を防ぐためです。
- Androidでは可能な場合に `CAMERA`/`RECORD_AUDIO` 権限のプロンプトが表示されます。権限が拒否された場合は `*_PERMISSION_REQUIRED` で失敗します。

## 画面録画（ノード）

対応するノードは `screen.record`（mp4）を公開します。例:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意事項:

- `screen.record` の利用可否はノードのプラットフォームに依存します。
- 画面録画は `<= 60s` に制限されます。
- `--no-audio` はサポートされているプラットフォームでマイクキャプチャを無効にします。
- 複数の画面が利用可能な場合、`--screen <index>` でディスプレイを選択してください。

## 位置情報（ノード）

設定で位置情報が有効になっている場合、ノードは `location.get` を公開します。

CLIヘルパー:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意事項:

- 位置情報は**デフォルトでオフ**です。
- 「常に許可」にはシステム権限が必要です。バックグラウンドフェッチはベストエフォートです。
- レスポンスには緯度/経度、精度（メートル）、タイムスタンプが含まれます。

## SMS（Androidノード）

ユーザーが**SMS**権限を付与し、デバイスがテレフォニーをサポートしている場合、Androidノードは `sms.send` を公開できます。

低レベルinvoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意事項:

- 機能がアドバタイズされる前に、Androidデバイスで権限プロンプトを受け入れる必要があります。
- テレフォニーなしのWi-Fi専用デバイスは `sms.send` をアドバタイズしません。

## Androidデバイス + 個人データコマンド

対応する機能が有効になっている場合、Androidノードは追加のコマンドファミリーをアドバタイズできます。

利用可能なファミリー:

- `device.status`、`device.info`、`device.permissions`、`device.health`
- `notifications.list`、`notifications.actions`
- `photos.latest`
- `contacts.search`、`contacts.add`
- `calendar.events`、`calendar.add`
- `callLog.search`
- `sms.search`
- `motion.activity`、`motion.pedometer`

invokeの例:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.status --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command notifications.list --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command photos.latest --params '{"limit":1}'
```

注意事項:

- モーションコマンドは利用可能なセンサーによって機能ゲートされています。

## システムコマンド（ノードホスト / Macノード）

macOSノードは `system.run`、`system.notify`、`system.execApprovals.get/set` を公開します。
ヘッドレスノードホストは `system.run`、`system.which`、`system.execApprovals.get/set` を公開します。

例:

```bash
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
openclaw nodes invoke --node <idOrNameOrIp> --command system.which --params '{"name":"git"}'
```

注意事項:

- `system.run` はペイロードでstdout/stderr/終了コードを返します。
- シェル実行は現在 `exec` ツールの `host=node` を経由します。`nodes` は明示的なノードコマンド用のダイレクトRPCサーフェスのままです。
- `nodes invoke` は `system.run` や `system.run.prepare` を公開しません。それらはexecパスのみに存在します。
- `system.notify` はmacOSアプリの通知権限状態を尊重します。
- 認識されないノードの `platform` / `deviceFamily` メタデータは、`system.run` と `system.which` を除外する保守的なデフォルト許可リストを使用します。不明なプラットフォームでこれらのコマンドが意図的に必要な場合は、`gateway.nodes.allowCommands` で明示的に追加してください。
- `system.run` は `--cwd`、`--env KEY=VAL`、`--command-timeout`、`--needs-screen-recording` をサポートします。
- シェルラッパー（`bash|sh|zsh ... -c/-lc`）の場合、リクエストスコープの `--env` 値は明示的な許可リスト（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）に限定されます。
- 許可リストモードでの常時許可の決定では、既知のディスパッチラッパー（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）はラッパーパスではなく内部の実行可能ファイルパスを永続化します。アンラップが安全でない場合、許可リストエントリは自動的に永続化されません。
- Windowsノードホストの許可リストモードでは、`cmd.exe /c` 経由のシェルラッパー実行には承認が必要です（許可リストエントリだけではラッパー形式を自動許可しません）。
- `system.notify` は `--priority <passive|active|timeSensitive>` と `--delivery <system|overlay|auto>` をサポートします。
- ノードホストは `PATH` のオーバーライドを無視し、危険なスタートアップ/シェルキー（`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`）を除去します。追加のPATHエントリが必要な場合は、`--env` で `PATH` を渡す代わりに、ノードホストサービスの環境を設定する（またはツールを標準的な場所にインストールする）ようにしてください。
- macOSノードモードでは、`system.run` はmacOSアプリのexec承認（設定 → exec承認）によってゲートされます。
  ask/許可リスト/フルはヘッドレスノードホストと同じ動作をします。拒否されたプロンプトは `SYSTEM_RUN_DENIED` を返します。
- ヘッドレスノードホストでは、`system.run` はexec承認（`~/.openclaw/exec-approvals.json`）によってゲートされます。

## execノードバインディング

複数のノードが利用可能な場合、execを特定のノードにバインドできます。
これにより `exec host=node` のデフォルトノードが設定されます（エージェントごとにオーバーライド可能）。

グローバルデフォルト:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

エージェントごとのオーバーライド:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

任意のノードを許可するには設定解除:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 権限マップ

ノードは `node.list` / `node.describe` で `permissions` マップを含めることがあります。権限名（例: `screenRecording`、`accessibility`）をキーとし、ブール値（`true` = 付与済み）を持ちます。

## ヘッドレスノードホスト（クロスプラットフォーム）

OpenClawは、Gateway ゲートウェイWebSocketに接続して `system.run` / `system.which` を公開する**ヘッドレスノードホスト**（UIなし）を実行できます。これはLinux/Windowsや、サーバーと並行して最小限のノードを実行する場合に便利です。

起動:

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意事項:

- ペアリングは引き続き必要です（Gateway ゲートウェイがデバイスペアリングプロンプトを表示します）。
- ノードホストは、ノードID、トークン、表示名、Gateway ゲートウェイ接続情報を `~/.openclaw/node.json` に保存します。
- exec承認はローカルの `~/.openclaw/exec-approvals.json` で強制されます
  （[exec承認](/tools/exec-approvals) を参照）。
- macOSでは、ヘッドレスノードホストはデフォルトでローカルに `system.run` を実行します。
  `OPENCLAW_NODE_EXEC_HOST=app` を設定するとコンパニオンアプリのexecホスト経由で `system.run` をルーティングします。
  `OPENCLAW_NODE_EXEC_FALLBACK=0` を追加するとアプリホストが必須となり、利用不可の場合はクローズドで失敗します。
- Gateway ゲートウェイWSがTLSを使用する場合は `--tls` / `--tls-fingerprint` を追加してください。

## Macノードモード

- macOSメニューバーアプリはGateway ゲートウェイWSサーバーにノードとして接続します（そのため `openclaw nodes …` がこのMacに対して動作します）。
- リモートモードでは、アプリがGateway ゲートウェイポート用のSSHトンネルを開き、`localhost` に接続します。
