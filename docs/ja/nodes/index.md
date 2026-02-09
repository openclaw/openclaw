---
summary: "ノード: ペアリング、機能、権限、そして canvas/camera/screen/system 用の CLI ヘルパー"
read_when:
  - iOS/Android ノードをゲートウェイにペアリングする場合
  - エージェントのコンテキストとしてノードの canvas/camera を使用する場合
  - 新しいノードコマンドや CLI ヘルパーを追加する場合
title: "Nodes"
---

# Nodes

**ノード**とは、Gateway **WebSocket**（オペレーターと同一ポート）に `role: "node"` で接続し、`node.invoke` を介して（例: `canvas.*`、`camera.*`、`system.*`）といったコマンドサーフェスを公開するコンパニオンデバイス（macOS/iOS/Android/ヘッドレス）です。プロトコルの詳細は次を参照してください: [Gateway protocol](/gateway/protocol)。 Protocol details: [Gateway protocol](/gateway/protocol).

レガシートランスポート: [Bridge protocol](/gateway/bridge-protocol)（TCP JSONL。現在のノードでは非推奨/削除済み）。

macOS は **node mode** でも実行できます。メニューバーアプリが Gateway の WS サーバーに接続し、ローカルの canvas/camera コマンドをノードとして公開します（そのため `openclaw nodes …` はこの Mac に対して動作します）。

注記:

- ノードは **周辺機器** であり、ゲートウェイではありません。ゲートウェイサービスは実行しません。 ゲートウェイサービスは実行されません。
- Telegram/WhatsApp などのメッセージはノードではなく **ゲートウェイ** に到達します。
- トラブルシューティング手順書: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pairing + status

**WS ノードはデバイスペアリングを使用します。** ノードは `connect` 中にデバイスアイデンティティを提示し、Gateway は `role: node` 向けのデバイスペアリング要求を作成します。デバイスの CLI（または UI）から承認してください。 デバイスCLI(またはUI)経由で承認します。

クイック CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注記:

- `nodes status` は、そのデバイスペアリングロールに `node` が含まれる場合にノードを **paired** としてマークします。
- `node.pair.*`（CLI: `openclaw nodes pending/approve/reject`）は、ゲートウェイ所有の独立したノードペアリングストアであり、WS の `connect` ハンドシェイクを制御するものでは **ありません**。

## Remote node host (system.run)

ゲートウェイがあるマシン上で動作し、コマンド
別のマシンで実行する場合は**ノードホスト** を使用します。 Gateway があるマシンとは別のマシンでコマンドを実行したい場合は、**node host** を使用します。モデルは引き続き **gateway** と通信し、`host=node` が選択されていると、ゲートウェイは `exec` 呼び出しを **node host** に転送します。

### What runs where

- **Gateway host**: メッセージを受信し、モデルを実行し、ツール呼び出しをルーティングします。
- **Node host**: ノードマシン上で `system.run`/`system.which` を実行します。
- **Approvals**: `~/.openclaw/exec-approvals.json` を介して node host 上で強制されます。

### Start a node host (foreground)

ノードマシン上で:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Remote gateway via SSH tunnel (loopback bind)

Gateway がループバック（`gateway.bind=loopback`、ローカルモードのデフォルト）にバインドしている場合、リモートの node host は直接接続できません。SSH トンネルを作成し、トンネルのローカル端を node host に指定してください。 SSHトンネルを作成し、トンネルのローカル端に
ノードホストを指定します。

例（node host → gateway host）:

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注記:

- トークンはゲートウェイ設定の `gateway.auth.token` です（ゲートウェイホスト上の `~/.openclaw/openclaw.json`）。
- `openclaw node run` は認証のために `OPENCLAW_GATEWAY_TOKEN` を読み取ります。

### Start a node host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Pair + name

ゲートウェイホスト上で:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

命名オプション:

- `openclaw node run` / `openclaw node install` 上の `--display-name`（ノード上の `~/.openclaw/node.json` に永続化されます）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（ゲートウェイ側の上書き）。

### Allowlist the commands

実行承認は **node host ごと** です。ゲートウェイから許可リストのエントリを追加します: 許可リストエントリをゲートウェイから追加:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

承認情報は node host 上の `~/.openclaw/exec-approvals.json` に保存されます。

### Point exec at the node

デフォルトを設定します（ゲートウェイ設定）:

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

またはセッションごとに:

```
/exec host=node security=allowlist node=<id-or-name>
```

設定後、`host=node` を伴う任意の `exec` 呼び出しは、（ノードの許可リスト/承認に従って）node host 上で実行されます。

関連:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

低レベル（raw RPC）:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

一般的な「エージェントに MEDIA 添付を与える」ワークフロー向けに、より高レベルのヘルパーが用意されています。

## Screenshots (canvas snapshots)

ノードが Canvas（WebView）を表示している場合、`canvas.snapshot` は `{ format, base64 }` を返します。

CLI ヘルパー（一時ファイルに書き込み、`MEDIA:<path>` を出力）:

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注記:

- `canvas present` は URL またはローカルファイルパス（`--target`）を受け付け、位置指定用のオプションとして `--x/--y/--width/--height` を指定できます。
- `canvas eval` はインライン JS（`--js`）または位置引数を受け付けます。

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注記:

- A2UI v0.8 JSONL のみがサポートされます（v0.9/createSurface は拒否されます）。

## Photos + videos (node camera)

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

注記:

- `canvas.*` および `camera.*` を使用するには、ノードが **フォアグラウンド** である必要があります（バックグラウンド呼び出しは `NODE_BACKGROUND_UNAVAILABLE` を返します）。
- クリップの長さは、過大な base64 ペイロードを避けるために制限されます（現在は `<= 60s`）。
- Android では可能な場合に `CAMERA`/`RECORD_AUDIO` 権限の許可が求められます。拒否された場合は `*_PERMISSION_REQUIRED` で失敗します。

## Screen recordings (nodes)

ノードは `screen.record`（mp4）を公開します。例: 2026-02-08T09:22:13Z

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注記:

- `screen.record` にはノードアプリがフォアグラウンドである必要があります。
- Android では録画前にシステムの画面キャプチャ確認が表示されます。
- 画面録画は `<= 60s` に制限されます。
- `--no-audio` はマイクキャプチャを無効化します（iOS/Android でサポート。macOS はシステムのキャプチャ音声を使用します）。
- 複数ディスプレイがある場合は `--screen <index>` を使用して表示を選択します。

## Location (nodes)

設定で Location が有効な場合、ノードは `location.get` を公開します。

CLI ヘルパー:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注記:

- Location は **デフォルトでオフ** です。
- 「常に許可」にはシステム権限が必要です。バックグラウンド取得はベストエフォートです。
- レスポンスには、緯度/経度、精度（メートル）、タイムスタンプが含まれます。

## SMS (Android nodes)

Android ノードは、ユーザーが **SMS** 権限を付与し、かつ端末が通話機能をサポートしている場合に `sms.send` を公開できます。

低レベル呼び出し:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注記:

- 機能がアドバタイズされる前に、Android 端末上で権限プロンプトを受諾する必要があります。
- 通話機能のない Wi‑Fi 専用デバイスは `sms.send` をアドバタイズしません。

## System commands (node host / mac node)

macOS ノードは `system.run`、`system.notify`、`system.execApprovals.get/set` を公開します。
ヘッドレス node host は `system.run`、`system.which`、`system.execApprovals.get/set` を公開します。
ヘッドレスノードホストは `system.run` 、 `system.which` 、 `system.execApprovals.get/set` を公開します。

例:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

注記:

- `system.run` は stdout/stderr/exit code をペイロードに含めて返します。
- `system.notify` は macOS アプリの通知権限の状態を尊重します。
- `system.run` は `--cwd`、`--env KEY=VAL`、`--command-timeout`、`--needs-screen-recording` をサポートします。
- `system.notify` は `--priority <passive|active|timeSensitive>` および `--delivery <system|overlay|auto>` をサポートします。
- macOS ノードは `PATH` の上書きを無視します。ヘッドレス node host は、node host の PATH を前置する場合にのみ `PATH` を受け付けます。
- macOS の node mode では、`system.run` は macOS アプリ内の実行承認（設定 → Exec approvals）によって制御されます。Ask/allowlist/full の挙動はヘッドレス node host と同一で、拒否されたプロンプトは `SYSTEM_RUN_DENIED` を返します。
  Ask/allowlist/full はヘッドレスノードホストと同じ動作をします。拒否されたプロンプトは `SYSTEM_RUN_DENIIED` を返します。
- ヘッドレス node host では、`system.run` は実行承認（`~/.openclaw/exec-approvals.json`）によって制御されます。

## Exec node binding

複数のノードが利用可能な場合、exec を特定のノードにバインドできます。
複数のノードが利用可能な場合、exec を特定のノードにバインドできます。
これにより `exec host=node` のデフォルトノードが設定されます（エージェントごとに上書き可能です）。

グローバルデフォルト:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

エージェントごとの上書き:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

任意のノードを許可するには解除します:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Permissions map

ノードは `node.list` / `node.describe` 内に `permissions` マップを含めることがあります。これは権限名（例: `screenRecording`、`accessibility`）をキーとし、ブール値（`true` = 付与済み）を値とします。

## Headless node host (cross-platform)

OpenClaw は、Gateway WebSocket に接続し `system.run` / `system.which` を公開する **ヘッドレス node host**（UI なし）を実行できます。これは Linux/Windows 上、またはサーバーと並行して最小構成のノードを実行する場合に有用です。 これは、Linux/Windows
またはサーバーと一緒に最小限のノードを実行する場合に便利です。

起動方法:

```bash
openclaw node run --host <gateway-host> --port 18789
```

注記:

- ペアリングは引き続き必要です（Gateway にノード承認プロンプトが表示されます）。
- node host は、ノード ID、トークン、表示名、ゲートウェイ接続情報を `~/.openclaw/node.json` に保存します。
- 実行承認は `~/.openclaw/exec-approvals.json` を介してローカルで強制されます
  （[Exec approvals](/tools/exec-approvals) を参照）。
- macOS では、ヘッドレス node host は到達可能な場合にコンパニオンアプリの exec host を優先し、アプリが利用不可の場合はローカル実行にフォールバックします。アプリを必須にするには `OPENCLAW_NODE_EXEC_HOST=app` を設定し、フォールバックを無効化するには `OPENCLAW_NODE_EXEC_FALLBACK=0` を設定します。 `OPENCLAW_NODE_EXEC_HOST=app` をアプリ
  必要にするか、フォールバックを無効にするには`OPENCLAW_NODE_EXEC_FALLBACK=0`を設定します。
- Gateway の WS が TLS を使用する場合は `--tls` / `--tls-fingerprint` を追加してください。

## Mac node mode

- macOS メニューバーアプリは、ノードとして Gateway WS サーバーに接続します（そのため `openclaw nodes …` はこの Mac に対して動作します）。
- リモートモードでは、アプリが Gateway ポート用の SSH トンネルを開き、`localhost` に接続します。
