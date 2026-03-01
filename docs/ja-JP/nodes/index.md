---
summary: "ノード: canvas/camera/screen/system のペアリング、機能、パーミッション、CLI ヘルパー"
read_when:
  - iOS/Android ノードを Gateway にペアリングするとき
  - エージェントコンテキスト用のノード canvas/camera を使用するとき
  - 新しいノードコマンドまたは CLI ヘルパーを追加するとき
title: "ノード"
---

# ノード

**ノード**は `role: "node"` で Gateway の **WebSocket**（オペレーターと同じポート）に接続し、`node.invoke` を通じてコマンドサーフェス（例: `canvas.*`、`camera.*`、`system.*`）を公開するコンパニオンデバイス（macOS/iOS/Android/ヘッドレス）です。プロトコルの詳細: [Gateway プロトコル](/gateway/protocol)。

レガシートランスポート: [ブリッジプロトコル](/gateway/bridge-protocol)（TCP JSONL; 現在のノードでは非推奨/削除済み）。

macOS は**ノードモード**でも動作できます: メニューバーアプリが Gateway の WS サーバーに接続し、ローカルの canvas/camera コマンドをノードとして公開します（この Mac に対して `openclaw nodes …` が動作します）。

注意:

- ノードは**周辺機器**であり、Gateway ではありません。Gateway サービスを実行しません。
- Telegram/WhatsApp/etc. のメッセージはノードではなく **Gateway** に届きます。
- トラブルシューティングのランブック: [/nodes/troubleshooting](/nodes/troubleshooting)

## ペアリングとステータス

**WS ノードはデバイスペアリングを使用します。** ノードは `connect` 時にデバイス識別情報を提示します。Gateway は `role: node` のデバイスペアリングリクエストを作成します。デバイス CLI（または UI）で承認します。

クイック CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注意:

- `nodes status` はデバイスペアリングロールに `node` が含まれている場合、ノードを**ペアリング済み**としてマークします。
- `node.pair.*`（CLI: `openclaw nodes pending/approve/reject`）は別の Gateway が所有するノードペアリングストアです。WS の `connect` ハンドシェイクをゲートしません。

## リモートノードホスト（system.run）

Gateway が一つのマシンで動作し、コマンドを別のマシンで実行したい場合は**ノードホスト**を使用します。モデルは引き続き **Gateway** と通信します。Gateway は `host=node` が選択された場合に `exec` コールを**ノードホスト**に転送します。

### 何がどこで実行されるか

- **Gateway ホスト**: メッセージを受信し、モデルを実行し、ツールコールをルーティングします。
- **ノードホスト**: ノードマシン上で `system.run`/`system.which` を実行します。
- **承認**: ノードホスト上で `~/.openclaw/exec-approvals.json` を通じて適用されます。

### ノードホストを起動する（フォアグラウンド）

ノードマシン上で:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH トンネル経由のリモート Gateway（ループバックバインド）

Gateway がループバック（`gateway.bind=loopback`、ローカルモードのデフォルト）にバインドしている場合、リモートノードホストは直接接続できません。SSH トンネルを作成して、ノードホストをトンネルのローカルエンドに向けます。

例（ノードホスト -> Gateway ホスト）:

```bash
# ターミナル A（実行し続ける）: ローカル 18790 -> Gateway 127.0.0.1:18789 を転送
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# ターミナル B: Gateway トークンをエクスポートしてトンネル経由で接続
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注意:

- トークンは Gateway ホストの Gateway 設定（`~/.openclaw/openclaw.json`）の `gateway.auth.token` です。
- `openclaw node run` は認証に `OPENCLAW_GATEWAY_TOKEN` を読み込みます。

### ノードホストを起動する（サービス）

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### ペアリングと名前付け

Gateway ホスト上で:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

命名オプション:

- `openclaw node run` / `openclaw node install` の `--display-name`（ノード上の `~/.openclaw/node.json` に保存されます）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（Gateway のオーバーライド）。

### コマンドの許可リスト

Exec の承認は**ノードホストごと**です。Gateway から許可リストエントリを追加します:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

承認はノードホストの `~/.openclaw/exec-approvals.json` に存在します。

### exec をノードに向ける

デフォルトを設定する（Gateway 設定）:

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

またはセッションごと:

```
/exec host=node security=allowlist node=<id-or-name>
```

設定すると、`host=node` を使用する `exec` コールはノードホスト上で実行されます（ノードの許可リスト/承認の対象）。

関連リンク:

- [ノードホスト CLI](/cli/node)
- [Exec ツール](/tools/exec)
- [Exec 承認](/tools/exec-approvals)

## コマンドの呼び出し

低レベル（生の RPC）:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

一般的な「エージェントに MEDIA 添付ファイルを提供する」ワークフロー用の高レベルヘルパーが存在します。

## スクリーンショット（canvas スナップショット）

ノードが Canvas（WebView）を表示している場合、`canvas.snapshot` は `{ format, base64 }` を返します。

CLI ヘルパー（一時ファイルに書き込んで `MEDIA:<path>` を出力）:

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas コントロール

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意:

- `canvas present` は URL またはローカルファイルパス（`--target`）を受け入れます。位置指定のためのオプションの `--x/--y/--width/--height` も使用できます。
- `canvas eval` はインライン JS（`--js`）または位置引数を受け入れます。

### A2UI（Canvas）

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意:

- A2UI v0.8 JSONL のみサポートされています（v0.9/createSurface は拒否されます）。

## 写真 + ビデオ（ノードカメラ）

写真（`jpg`）:

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # デフォルト: 両方の向き（2 つの MEDIA 行）
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

ビデオクリップ（`mp4`）:

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意:

- `canvas.*` と `camera.*` のためにノードが**フォアグラウンド**である必要があります（バックグラウンドコールは `NODE_BACKGROUND_UNAVAILABLE` を返します）。
- クリップの長さは（現在 `<= 60秒`）にクランプされており、過大な base64 ペイロードを避けます。
- Android は可能であれば `CAMERA`/`RECORD_AUDIO` パーミッションを求めます。拒否されたパーミッションは `*_PERMISSION_REQUIRED` で失敗します。

## スクリーン録画（ノード）

ノードは `screen.record`（mp4）を公開します。例:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意:

- `screen.record` はノードアプリがフォアグラウンドである必要があります。
- Android は録画前にシステムの画面キャプチャプロンプトを表示します。
- スクリーン録画は `<= 60秒` にクランプされます。
- `--no-audio` はマイクキャプチャを無効にします（iOS/Android でサポート。macOS はシステムキャプチャ音声を使用）。
- 複数の画面が利用可能な場合、`--screen <index>` でディスプレイを選択します。

## 位置情報（ノード）

ノードは設定で位置情報が有効になっている場合に `location.get` を公開します。

CLI ヘルパー:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意:

- 位置情報は**デフォルトでオフ**です。
- 「常に」はシステムパーミッションが必要です。バックグラウンドフェッチはベストエフォートです。
- レスポンスには緯度/経度、精度（メートル）、タイムスタンプが含まれます。

## SMS（Android ノード）

Android ノードはユーザーが **SMS** パーミッションを付与し、デバイスがテレフォニーをサポートしている場合に `sms.send` を公開できます。

低レベルの呼び出し:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意:

- 機能が通知される前に Android デバイスでパーミッションプロンプトを受け入れる必要があります。
- テレフォニーのない Wi-Fi のみのデバイスは `sms.send` を通知しません。

## システムコマンド（ノードホスト / mac ノード）

macOS ノードは `system.run`、`system.notify`、`system.execApprovals.get/set` を公開します。ヘッドレスノードホストは `system.run`、`system.which`、`system.execApprovals.get/set` を公開します。

例:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

注意:

- `system.run` はペイロードで stdout/stderr/終了コードを返します。
- `system.notify` は macOS アプリの通知パーミッション状態を尊重します。
- `system.run` は `--cwd`、`--env KEY=VAL`、`--command-timeout`、`--needs-screen-recording` をサポートします。
- シェルラッパー（`bash|sh|zsh ... -c/-lc`）の場合、リクエストスコープの `--env` 値は明示的な許可リスト（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）に絞り込まれます。
- 許可リストモードでの always-allow 決定の場合、既知のディスパッチラッパー（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）はラッパーパスの代わりに内部の実行ファイルパスを保持します。アンラップが安全でない場合、許可リストエントリは自動的に保持されません。
- 許可リストモードの Windows ノードホストでは、`cmd.exe /c` を通じたシェルラッパー実行は承認が必要です（許可リストエントリだけではラッパー形式を自動許可しません）。
- `system.notify` は `--priority <passive|active|timeSensitive>` と `--delivery <system|overlay|auto>` をサポートします。
- ノードホストは `PATH` オーバーライドを無視して危険なスタートアップ/シェルキー（`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`）を取り除きます。追加の PATH エントリが必要な場合は、`--env` で `PATH` を渡すのではなく、ノードホストサービス環境を設定するか、標準的な場所にツールをインストールしてください。
- macOS ノードモードでは、`system.run` は macOS アプリの exec 承認（設定 → Exec 承認）でゲートされます。ask/allowlist/full は headless ノードホストと同様に動作します。拒否されたプロンプトは `SYSTEM_RUN_DENIED` を返します。
- ヘッドレスノードホストでは、`system.run` は exec 承認（`~/.openclaw/exec-approvals.json`）でゲートされます。

## Exec ノードバインディング

複数のノードが利用可能な場合、特定のノードに exec をバインドできます。これは `exec host=node` のデフォルトノードを設定します（エージェントごとにオーバーライド可能）。

グローバルデフォルト:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

エージェントごとのオーバーライド:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

任意のノードを許可するには設定を解除:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## パーミッションマップ

ノードは `node.list` / `node.describe` にパーミッション名（例: `screenRecording`、`accessibility`）をキーとするブーリアン値（`true` = 付与済み）を持つ `permissions` マップを含めることができます。

## ヘッドレスノードホスト（クロスプラットフォーム）

OpenClaw は Gateway WebSocket に接続して `system.run` / `system.which` を公開する**ヘッドレスノードホスト**（UI なし）を実行できます。Linux/Windows でやサーバーの隣で最小限のノードを実行するのに便利です。

起動方法:

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意:

- ペアリングは引き続き必要です（Gateway はノード承認プロンプトを表示します）。
- ノードホストはノード ID、トークン、表示名、Gateway 接続情報を `~/.openclaw/node.json` に保存します。
- Exec 承認はローカルで `~/.openclaw/exec-approvals.json` を通じて適用されます（[Exec 承認](/tools/exec-approvals) 参照）。
- macOS では、ヘッドレスノードホストはデフォルトでローカルに `system.run` を実行します。`OPENCLAW_NODE_EXEC_HOST=app` を設定するとコンパニオンアプリの exec ホスト経由で `system.run` をルーティングします。アプリホストが必要で利用不可の場合は `OPENCLAW_NODE_EXEC_FALLBACK=0` を追加してフェイルクローズにします。
- Gateway WS が TLS を使用する場合は `--tls` / `--tls-fingerprint` を追加してください。

## Mac ノードモード

- macOS メニューバーアプリは Gateway WS サーバーにノードとして接続します（この Mac に対して `openclaw nodes …` が動作します）。
- リモートモードでは、アプリは Gateway ポート用に SSH トンネルを開いて `localhost` に接続します。
