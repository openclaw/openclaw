---
summary: "Gateway サービスの運用、ライフサイクル、およびオペレーションのためのランブック"
read_when:
  - ゲートウェイプロセスを実行またはデバッグする場合
title: "Gateway ランブック"
---

# Gateway サービスランブック

最終更新日: 2025-12-09

## これは何か

- 単一の Baileys/Telegram 接続と制御／イベントプレーンを所有する常駐プロセスです。
- レガシーの `gateway` コマンドを置き換えます。 旧来の `gateway` コマンドを置き換えます。CLI エントリーポイントは `openclaw gateway` です。
- 停止されるまで実行され続け、致命的なエラー時には非ゼロで終了してスーパーバイザーが再起動します。

## 実行方法（ローカル）

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- 設定のホットリロードは `~/.openclaw/openclaw.json`（または `OPENCLAW_CONFIG_PATH`）を監視します。
  - デフォルトモード: `gateway.reload.mode="hybrid"`（安全な変更はホット適用、重大な変更は再起動）。
  - ホットリロードは必要に応じて **SIGUSR1** によるプロセス内再起動を使用します。
  - `gateway.reload.mode="off"` で無効化できます。
- WebSocket の制御プレーンを `127.0.0.1:<port>`（デフォルト 18789）にバインドします。
- 同一ポートで HTTP（制御 UI、フック、A2UI）も提供します。単一ポートのマルチプレックスです。 単一ポートマルチプレックス。
  - OpenAI Chat Completions（HTTP）: [`/v1/chat/completions`](/gateway/openai-http-api)。
  - OpenResponses（HTTP）: [`/v1/responses`](/gateway/openresponses-http-api)。
  - Tools Invoke（HTTP）: [`/tools/invoke`](/gateway/tools-invoke-http-api)。
- デフォルトで `canvasHost.port`（デフォルト `18793`）に Canvas ファイルサーバーを起動し、`~/.openclaw/workspace/canvas` から `http://<gateway-host>:18793/__openclaw__/canvas/` を提供します。`canvasHost.enabled=false` または `OPENCLAW_SKIP_CANVAS_HOST=1` で無効化できます。 `canvasHost.enabled=false` または `OPENCLAW_SKIP_CANVAS_HOST=1` で無効にします。
- ログは stdout に出力されます。常駐とログローテーションには launchd/systemd を使用してください。
- トラブルシューティング時に `--verbose` を渡すと、デバッグログ（ハンドシェイク、req/res、イベント）をログファイルから stdio にミラーします。
- `--force` は `lsof` を使用して選択されたポートのリスナーを検出し、SIGTERM を送信して、終了させた内容をログに記録してから Gateway を起動します（`lsof` が欠落している場合は即座に失敗します）。
- スーパーバイザー（launchd/systemd/mac アプリの子プロセスモード）配下で実行している場合、停止／再起動は通常 **SIGTERM** を送信します。古いビルドではこれが `pnpm` `ELIFECYCLE` 終了コード **143**（SIGTERM）として表示されることがありますが、これはクラッシュではなく正常終了です。
- **SIGUSR1** は、認可されている場合（Gateway ツール／設定の適用／更新、または手動再起動用に `commands.restart` を有効化した場合）にプロセス内再起動をトリガーします。
- Gateway の認証はデフォルトで必須です。`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）もしくは `gateway.auth.password` を設定してください。Tailscale Serve のアイデンティティを使用しない限り、クライアントは `connect.params.auth.token/password` を送信する必要があります。 クライアントは Tailscale Serve ID を使用しない限り、`connect.params.auth.token/password` を送信する必要があります。
- ウィザードは、ループバックであってもデフォルトでトークンを生成するようになりました。
- ポートの優先順位: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > デフォルト `18789`。

## リモートアクセス

- Tailscale/VPN を推奨します。それ以外の場合は SSH トンネルを使用します。

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- クライアントはトンネル経由で `ws://127.0.0.1:18789` に接続します。

- トークンが設定されている場合、トンネル経由であってもクライアントは `connect.params.auth.token` にトークンを含める必要があります。

## 複数 Gateway（同一ホスト）

通常は不要です。1 つの Gateway で複数のメッセージングチャンネルとエージェントを提供できます。冗長化や厳密な分離（例: レスキューボット）のためにのみ、複数 Gateway を使用してください。 冗長または厳密な単離(例:レスキューボット)にのみ複数のゲートウェイを使用します。

状態と設定を分離し、ユニークなポートを使用すればサポートされます。完全なガイド: [Multiple gateways](/gateway/multiple-gateways)。 完全ガイド: [Multiple gateways](/gateway/multiple-gateways)。

サービス名はプロファイルを認識します。

- macOS: `bot.molt.<profile>`（旧 `com.openclaw.*` が残っている場合があります）
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

インストールメタデータはサービス設定に埋め込まれています。

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

レスキューボットパターン: 独自のプロファイル、状態ディレクトリ、ワークスペース、およびベースポート間隔を持つ 2 つ目の Gateway を分離して保持します。完全なガイド: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide)。 フルガイド: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide)。

### Dev プロファイル（`--dev`）

高速パス: 主要なセットアップに触れずに、完全に分離された dev インスタンス（設定／状態／ワークスペース）を実行します。

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

デフォルト（env／フラグ／設定で上書き可能）:

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001`（Gateway WS + HTTP）
- ブラウザ制御サービスのポート = `19003`（派生: `gateway.port+2`、ループバックのみ）
- `canvasHost.port=19005`（派生: `gateway.port+4`）
- `agents.defaults.workspace` は、`--dev` 配下で `setup`/`onboard` を実行するとデフォルトで `~/.openclaw/workspace-dev` になります。

派生ポート（目安）:

- ベースポート = `gateway.port`（または `OPENCLAW_GATEWAY_PORT` / `--port`）
- ブラウザ制御サービスのポート = ベース + 2（ループバックのみ）
- `canvasHost.port = base + 4`（または `OPENCLAW_CANVAS_HOST_PORT` / 設定での上書き）
- ブラウザプロファイルの CDP ポートは `browser.controlPort + 9 .. + 108` から自動割り当て（プロファイルごとに永続化）。

インスタンスごとのチェックリスト:

- 一意の `gateway.port`
- 一意の `OPENCLAW_CONFIG_PATH`
- 一意の `OPENCLAW_STATE_DIR`
- 一意の `agents.defaults.workspace`
- WhatsApp を使用する場合は別々の WhatsApp 番号

プロファイルごとのサービスインストール:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

例:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## プロトコル（オペレーター視点）

- 完全なドキュメント: [Gateway protocol](/gateway/protocol) および [Bridge protocol（レガシー）](/gateway/bridge-protocol)。
- クライアントからの必須の最初のフレーム: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`。
- Gateway は `res {type:"res", id, ok:true, payload:hello-ok }` を返信します（またはエラー付きの `ok:false` を返してクローズします）。
- ハンドシェイク後:
  - リクエスト: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - イベント: `{type:"event", event, payload, seq?, stateVersion?}`
- 構造化された presence エントリ: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`（WS クライアントの場合、`instanceId` は `connect.client.instanceId` から提供されます）。
- `agent` のレスポンスは 2 段階です。まず `res` の ack `{runId,status:"accepted"}`、次に実行完了後の最終 `res` `{runId,status:"ok"|"error",summary}`。ストリーミング出力は `event:"agent"` として到着します。

## メソッド（初期セット）

- `health` — 完全なヘルススナップショット（`openclaw health --json` と同一の形状）。
- `status` — 簡易サマリー。
- `system-presence` — 現在の presence リスト。
- `system-event` — presence／システムノートを投稿（構造化）。
- `send` — アクティブなチャンネル経由でメッセージを送信。
- `agent` — エージェントの 1 ターンを実行（同一接続でイベントをストリーム）。
- `node.list` — ペアリング済みおよび現在接続中のノード一覧（`caps`、`deviceFamily`、`modelIdentifier`、`paired`、`connected`、および広告された `commands` を含む）。
- `node.describe` — ノードを記述（機能 + サポートされる `node.invoke` コマンド。ペアリング済みノードおよび現在接続中の未ペアリングノードの双方で動作）。
- `node.invoke` — ノード上でコマンドを実行（例: `canvas.*`、`camera.*`）。
- `node.pair.*` — ペアリングのライフサイクル（`request`、`list`、`approve`、`reject`、`verify`）。

presence の生成／重複排除の仕組みや、安定した `client.instanceId` が重要な理由については [Presence](/concepts/presence) も参照してください。

## イベント

- `agent` — エージェント実行からのツール／出力イベントのストリーム（seq タグ付き）。
- `presence` — presence 更新（stateVersion 付きの差分）が接続中のすべてのクライアントにプッシュされます。
- `tick` — 生存確認のための定期的な keepalive／no-op。
- `shutdown` — Gateway が終了中。ペイロードには `reason` と任意の `restartExpectedMs` が含まれます。クライアントは再接続してください。 クライアントは再接続する必要があります。

## WebChat 連携

- WebChat は Gateway WebSocket と直接通信して履歴、送信、中断、イベントを扱うネイティブ SwiftUI UI です。
- リモート利用は同じ SSH/Tailscale トンネルを使用します。gateway トークンが設定されている場合、クライアントは `connect` の間にそれを含めます。
- macOS アプリは単一の WS（共有接続）で接続し、初期スナップショットから presence をハイドレートし、UI 更新のために `presence` イベントをリッスンします。

## 型付けと検証

- サーバーは受信するすべてのフレームを、プロトコル定義から生成された JSON Schema に対して AJV で検証します。
- クライアント（TS/Swift）は生成された型を消費します（TS は直接、Swift はリポジトリのジェネレーター経由）。
- プロトコル定義が単一の真実のソースです。次でスキーマ／モデルを再生成します。
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## 接続スナップショット

- `hello-ok` には、`presence`、`health`、`stateVersion`、`uptimeMs`、および `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` を含む `snapshot` が含まれ、追加リクエストなしで即座に描画できます。
- `health`/`system-presence` は手動更新用として引き続き利用できますが、接続時には必須ではありません。

## エラーコード（res.error 形状）

- エラーは `{ code, message, details?, retryable?, retryAfterMs? }` を使用します。
- 標準コード:
  - `NOT_LINKED` — WhatsApp が認証されていません。
  - `AGENT_TIMEOUT` — エージェントが設定された期限内に応答しませんでした。
  - `INVALID_REQUEST` — スキーマ／パラメータ検証に失敗しました。
  - `UNAVAILABLE` — Gateway がシャットダウン中、または依存関係が利用できません。

## Keepalive の挙動

- `tick` イベント（または WS の ping/pong）が定期的に送出され、トラフィックがない場合でも Gateway が生存していることをクライアントに知らせます。
- 送信／エージェントの確認応答は別個のレスポンスとして維持してください。ticks を送信に流用しないでください。

## リプレイ／ギャップ

- イベントは再生されません。 クライアントはseqギャップを検出し、続行する前にリフレッシュする必要があります (`health` + `system-presence`)。 WebChat および macOS クライアントがギャップ時に自動更新されるようになりました。

## スーパービジョン（macOS 例）

- サービスを常駐させるために launchd を使用します。
  - Program: `openclaw` へのパス
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: ファイルパス、または `syslog`
- 障害時には launchd が再起動します。致命的な設定ミスは、オペレーターが気付くように終了し続けるべきです。
- LaunchAgents はユーザーごとで、ログイン中のセッションが必要です。ヘッドレス構成ではカスタム LaunchDaemon（未同梱）を使用してください。
  - `openclaw gateway install` は `~/Library/LaunchAgents/bot.molt.gateway.plist` を書き込みます
    （または `bot.molt.<profile>.plist`。旧 `com.openclaw.*` はクリーンアップされます）。
  - `openclaw doctor` は LaunchAgent 設定を監査し、最新のデフォルトに更新できます。

## Gateway サービス管理（CLI）

インストール／開始／停止／再起動／状態確認には Gateway CLI を使用します。

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

注記:

- `gateway status` は、サービスの解決済みポート／設定を使用してデフォルトで Gateway RPC をプローブします（`--url` で上書き可能）。
- `gateway status --deep` はシステムレベルのスキャン（LaunchDaemons/systemd ユニット）を追加します。
- `gateway status --no-probe` は RPC プローブをスキップします（ネットワークがダウンしている場合に有用）。
- `gateway status --json` はスクリプト向けに安定しています。
- `gateway status` は **スーパーバイザーの実行状態**（launchd/systemd が稼働中）と **RPC 到達性**（WS 接続 + status RPC）を別々に報告します。
- `gateway status` は設定パスとプローブ対象を出力し、「localhost と LAN バインド」の混乱やプロファイル不一致を防ぎます。
- `gateway status` は、サービスが稼働しているように見えるがポートが閉じている場合に、最後の gateway エラー行を含めます。
- `logs` は RPC 経由で Gateway のファイルログを tail します（手動の `tail`/`grep` は不要）。
- 他の gateway 類似サービスが検出された場合、OpenClaw プロファイルサービスでない限り CLI は警告します。
  ほとんどの構成では **1 マシンあたり 1 Gateway** を推奨します。冗長化やレスキューボットには分離したプロファイル／ポートを使用してください。[Multiple gateways](/gateway/multiple-gateways) を参照してください。
  ほとんどのセットアップでは**1つのゲートウェイ**をお勧めします。冗長性またはレスキューボットを使用するには、隔離されたプロファイル/ポートを使用します。 [Multiple gateways](/gateway/multiple-gateways) を参照してください。
  - クリーンアップ: `openclaw gateway uninstall`（現行サービス）および `openclaw doctor`（レガシー移行）。
- `gateway install` は既にインストールされている場合は no-op です。再インストールには `openclaw gateway install --force` を使用してください（プロファイル／環境／パスの変更）。

同梱の mac アプリ:

- OpenClaw.app は Node ベースの gateway リレーを同梱し、ラベル
  `bot.molt.gateway`（または `bot.molt.<profile>`。旧 `com.openclaw.*` ラベルもクリーンにアンロードされます）
  のユーザー単位 LaunchAgent をインストールできます。
- 正常に停止するには `openclaw gateway stop`（または `launchctl bootout gui/$UID/bot.molt.gateway`）を使用します。
- 再起動するには `openclaw gateway restart`（または `launchctl kickstart -k gui/$UID/bot.molt.gateway`）を使用します。
  - `launchctl` は LaunchAgent がインストールされている場合にのみ動作します。そうでない場合は先に `openclaw gateway install` を使用してください。
  - 名前付きプロファイルを実行する場合は、ラベルを `bot.molt.<profile>` に置き換えてください。

## スーパービジョン（systemd ユーザーユニット）

OpenClaw は Linux/WSL2 でデフォルトで **systemd ユーザーサービス** をインストールします。単一ユーザーのマシンでは（環境が簡単で、ユーザーごとの設定になるため）ユーザーサービスを推奨します。
複数ユーザーまたは常時稼働サーバーでは **system サービス** を使用してください（linger 不要、共有スーパービジョン）。
は、シングルユーザマシンのユーザー・サービスをお勧めします (より簡単な env、ユーザ毎の設定)。
マルチユーザーまたは常時稼働サーバーには **システムサービス** を使用してください（常駐は不要、共有監視）。

`openclaw gateway install` はユーザーユニットを書き込みます。 `openclaw doctor`は
ユニットを監査し、現在推奨されているデフォルトに合わせて更新できます。

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` を作成します。

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

ログアウト／アイドル後もユーザーサービスを維持するため、linger を有効化します（必須）。

```
sudo loginctl enable-linger youruser
```

オンボーディングは Linux/WSL2 でこれを実行します（sudo を要求する場合があります。`/var/lib/systemd/linger` を書き込みます）。
その後、サービスを有効化します。
次に、サービスを有効にします:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternative (system service)** - always-on or multi-user servers, you can
a systemd **system** unit instead (no lingering need).
**代替（system サービス）** — 常時稼働または複数ユーザーのサーバーでは、ユーザーユニットの代わりに systemd の **system** ユニットをインストールできます（linger 不要）。
`/etc/systemd/system/openclaw-gateway[-<profile>].service` を作成し（上記ユニットをコピーし、
`WantedBy=multi-user.target` を切り替え、`User=` + `WorkingDirectory=` を設定）、次を実行します。

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows（WSL2）

Windows へのインストールは **WSL2** を使用し、上記の Linux systemd セクションに従ってください。

## 運用チェック

- Liveness: WS を開き `req:connect` を送信 → `res` と `payload.type="hello-ok"`（スナップショット付き）を期待します。
- Readiness: `health` を呼び出し → `ok: true` と、該当する場合は `linkChannel` 内のリンクされたチャンネルを期待します。
- Debug: `tick` および `presence` イベントを購読し、`status` にリンク／認証の経過時間が表示されていること、presence エントリに Gateway ホストと接続中クライアントが表示されていることを確認します。

## 安全性の保証

- デフォルトではホストごとに 1 Gateway を想定します。複数プロファイルを実行する場合は、ポート／状態を分離し、正しいインスタンスを対象にしてください。
- 直接の Baileys 接続へのフォールバックはありません。Gateway がダウンしている場合、送信は即座に失敗します。
- 接続以外の最初のフレームや不正な JSON は拒否され、ソケットはクローズされます。
- グレースフルシャットダウン: クローズ前に `shutdown` イベントを送出します。クライアントはクローズと再接続を処理する必要があります。

## CLI ヘルパー

- `openclaw gateway health|status` — Gateway WS 経由でヘルス／ステータスを要求します。
- `openclaw message send --target <num> --message "hi" [--media ...]` — Gateway 経由で送信（WhatsApp では冪等）。
- `openclaw agent --message "hi" --to <num>` — エージェントの 1 ターンを実行（デフォルトでは最終結果を待機）。
- `openclaw gateway call <method> --params '{"k":"v"}'` — デバッグ用の生メソッド呼び出し。
- `openclaw gateway stop|restart` — スーパーバイザー管理下の Gateway サービスを停止／再起動（launchd/systemd）。
- Gateway ヘルパーのサブコマンドは、`--url` 上で稼働中の gateway を前提とします。自動起動は行われません。

## 移行ガイダンス

- `openclaw gateway` および旧来の TCP 制御ポートの使用を廃止してください。
- 必須の connect と構造化された presence を備えた WS プロトコルを話すよう、クライアントを更新してください。
