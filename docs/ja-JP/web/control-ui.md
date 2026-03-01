---
summary: "ブラウザベースの Gateway 用コントロール UI（チャット、ノード、設定）"
read_when:
  - ブラウザから Gateway を操作したい場合
  - SSH トンネルなしで Tailnet アクセスが必要な場合
title: "コントロール UI"
---

# コントロール UI（ブラウザ）

コントロール UI は、Gateway が提供する小さな **Vite + Lit** のシングルページアプリです。

- デフォルト: `http://<host>:18789/`
- オプションのプレフィックス: `gateway.controlUi.basePath` を設定（例: `/openclaw`）

同じポート上の **Gateway WebSocket に直接接続**します。

## クイックオープン（ローカル）

Gateway が同じコンピューターで実行されている場合は、以下を開きます。

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（または [http://localhost:18789/](http://localhost:18789/)）

ページが読み込まれない場合は、まず Gateway を起動してください: `openclaw gateway`

認証は WebSocket ハンドシェイク時に以下を通じて提供されます。

- `connect.params.auth.token`
- `connect.params.auth.password`
  ダッシュボードの設定パネルでトークンを保存できます。パスワードは保存されません。
  オンボーディングウィザードはデフォルトで Gateway トークンを生成するため、初回接続時にここに貼り付けてください。

## デバイスのペアリング（初回接続）

新しいブラウザまたはデバイスからコントロール UI に接続する場合、Gateway は
**ワンタイムのペアリング承認**を要求します。同じ Tailnet 上で `gateway.auth.allowTailscale: true` が設定されていても同様です。これは不正アクセスを防ぐためのセキュリティ対策です。

**表示されるメッセージ:** 「disconnected (1008): pairing required」

**デバイスを承認するには:**

```bash
# 保留中のリクエストを一覧表示
openclaw devices list

# リクエスト ID で承認
openclaw devices approve <requestId>
```

承認されたデバイスは記憶され、`openclaw devices revoke --device <id> --role <role>` で取り消さない限り再承認は不要です。トークンのローテーションと取り消しについては [Devices CLI](/cli/devices) を参照してください。

**注意事項:**

- ローカル接続（`127.0.0.1`）は自動承認されます。
- リモート接続（LAN、Tailnet など）には明示的な承認が必要です。
- ブラウザプロファイルごとに一意のデバイス ID が生成されるため、ブラウザを切り替えたりブラウザのデータをクリアしたりすると再ペアリングが必要になります。

## 現在できること

- Gateway WS 経由でモデルとチャット（`chat.history`、`chat.send`、`chat.abort`、`chat.inject`）
- チャットでのツール呼び出しのストリーミングとライブツール出力カード（エージェントイベント）
- チャンネル: WhatsApp/Telegram/Discord/Slack + プラグインチャンネル（Mattermost など）のステータス + QR ログイン + チャンネルごとの設定（`channels.status`、`web.login.*`、`config.patch`）
- インスタンス: プレゼンスリストとリフレッシュ（`system-presence`）
- セッション: 一覧 + セッションごとのシンキング/詳細モードのオーバーライド（`sessions.list`、`sessions.patch`）
- Cron ジョブ: 一覧/追加/編集/実行/有効化/無効化 + 実行履歴（`cron.*`）
- スキル: ステータス、有効化/無効化、インストール、API キーの更新（`skills.*`）
- ノード: 一覧 + ケーパビリティ（`node.list`）
- Exec 承認: Gateway またはノードの許可リストの編集 + `exec host=gateway/node` のポリシーの確認（`exec.approvals.*`）
- 設定: `~/.openclaw/openclaw.json` の表示/編集（`config.get`、`config.set`）
- 設定: バリデーション付きの適用と再起動（`config.apply`）および最後にアクティブだったセッションのウェイクアップ
- 設定の書き込みには、同時編集による上書きを防ぐベースハッシュガードが含まれます
- 設定スキーマとフォームレンダリング（`config.schema`、プラグインとチャンネルのスキーマを含む）。Raw JSON エディターも引き続き利用可能
- デバッグ: ステータス/ヘルス/モデルのスナップショット + イベントログ + 手動 RPC 呼び出し（`status`、`health`、`models.list`）
- ログ: フィルター/エクスポート付きの Gateway ファイルログのライブテール（`logs.tail`）
- アップデート: パッケージ/git の更新と再起動の実行（`update.run`）および再起動レポート

Cron ジョブパネルの注意事項:

- 独立したジョブの場合、デフォルトの配信はアナウンスサマリーです。内部専用の実行が必要な場合は none に切り替えることができます。
- アナウンスが選択されると、チャンネル/ターゲットのフィールドが表示されます。
- Webhook モードは `delivery.mode = "webhook"` を使用し、`delivery.to` に有効な HTTP(S) Webhook URL を設定します。
- メインセッションジョブでは、webhook と none の配信モードが利用可能です。
- 高度な編集コントロールには、実行後削除、エージェントオーバーライドのクリア、cron の正確/ずらしのオプション、エージェントモデル/シンキングオーバーライド、ベストエフォート配信のトグルが含まれます。
- フォームバリデーションはインラインでフィールドレベルのエラーを表示します。無効な値があると、修正されるまで保存ボタンが無効になります。
- 専用のベアラートークンを送信するには `cron.webhookToken` を設定してください。省略すると、Webhook は認証ヘッダーなしで送信されます。
- 廃止予定のフォールバック: `notify: true` で保存されたレガシージョブは、移行するまで `cron.webhook` を引き続き使用できます。

## チャットの動作

- `chat.send` は**ノンブロッキング**です。即座に `{ runId, status: "started" }` で応答し、レスポンスは `chat` イベント経由でストリーミングされます。
- 同じ `idempotencyKey` で再送信すると、実行中は `{ status: "in_flight" }` が返され、完了後は `{ status: "ok" }` が返されます。
- `chat.history` のレスポンスは UI の安定性のためにサイズ制限されています。トランスクリプトのエントリが大きすぎる場合、Gateway は長いテキストフィールドを切り詰め、重いメタデータブロックを省略し、サイズオーバーのメッセージをプレースホルダー（`[chat.history omitted: message too large]`）で置き換えることがあります。
- `chat.inject` は、セッションのトランスクリプトにアシスタントのノートを追加し、UI のみの更新のために `chat` イベントをブロードキャストします（エージェントの実行やチャンネルへの配信は行われません）。
- 停止方法:
  - **Stop** をクリック（`chat.abort` を呼び出す）
  - `/stop`（または `stop`、`stop action`、`stop run`、`stop openclaw`、`please stop` などの単独アボートフレーズ）を入力してアウトオブバンドでアボート
  - `chat.abort` は `{ sessionKey }`（`runId` なし）をサポートし、そのセッションのすべてのアクティブな実行をアボートします
- アボート時の部分的なコンテンツの保持:
  - 実行がアボートされた場合、部分的なアシスタントテキストが UI に表示され続けることがあります
  - バッファされた出力が存在する場合、Gateway はアボートされた部分的なアシスタントテキストをトランスクリプト履歴に保存します
  - 保存されたエントリにはアボートメタデータが含まれるため、トランスクリプトのコンシューマーはアボートによる部分的な出力と通常の完了出力を区別できます

## Tailnet アクセス（推奨）

### 統合 Tailscale Serve（推奨）

Gateway をループバックに保ち、Tailscale Serve が HTTPS でプロキシするようにします。

```bash
openclaw gateway --tailscale serve
```

開く先:

- `https://<magicdns>/`（または設定した `gateway.controlUi.basePath`）

デフォルトでは、`gateway.auth.allowTailscale` が `true` の場合、コントロール UI/WebSocket Serve リクエストは Tailscale のアイデンティティヘッダー（`tailscale-user-login`）で認証できます。OpenClaw は `tailscale whois` で `x-forwarded-for` アドレスを解決してヘッダーと照合することでアイデンティティを確認し、リクエストが Tailscale の `x-forwarded-*` ヘッダー付きでループバックに到達した場合のみ受け入れます。Serve トラフィックに対してもトークン/パスワードを要求する場合は、`gateway.auth.allowTailscale: false`（または `gateway.auth.mode: "password"` を強制）を設定してください。
トークンなしの Serve 認証は、Gateway ホストが信頼できることを前提としています。そのホストで信頼できないローカルコードが実行される可能性がある場合は、トークン/パスワード認証を要求してください。

### Tailnet にバインド + トークン

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

次に開く:

- `http://<tailscale-ip>:18789/`（または設定した `gateway.controlUi.basePath`）

トークンを UI の設定に貼り付けてください（`connect.params.auth.token` として送信されます）。

## 安全でない HTTP

プレーン HTTP（`http://<lan-ip>` または `http://<tailscale-ip>`）でダッシュボードを開くと、ブラウザは**非セキュアコンテキスト**で実行されるため WebCrypto がブロックされます。デフォルトでは、OpenClaw はデバイスアイデンティティのないコントロール UI 接続を**ブロック**します。

**推奨される修正方法:** HTTPS（Tailscale Serve）を使用するか、UI をローカルで開きます。

- `https://<magicdns>/`（Serve）
- `http://127.0.0.1:18789/`（Gateway ホスト上）

**安全でない認証のトグル動作:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth` はコントロール UI のデバイスアイデンティティやペアリングチェックをバイパスしません。

**緊急時のみ:**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth` はコントロール UI のデバイスアイデンティティチェックを無効化し、深刻なセキュリティの低下を招きます。緊急時使用後は速やかに元に戻してください。

HTTPS セットアップのガイダンスについては [Tailscale](/gateway/tailscale) を参照してください。

## UI のビルド

Gateway は `dist/control-ui` から静的ファイルを配信します。以下でビルドします。

```bash
pnpm ui:build # 初回実行時に UI の依存関係を自動インストール
```

オプションの絶対ベース（固定アセット URL が必要な場合）:

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

ローカル開発用（別の開発サーバー）:

```bash
pnpm ui:dev # 初回実行時に UI の依存関係を自動インストール
```

その後、Gateway の WebSocket URL（例: `ws://127.0.0.1:18789`）を UI に向けてください。

## デバッグ/テスト: 開発サーバー + リモート Gateway

コントロール UI は静的ファイルです。WebSocket のターゲットは設定可能で、HTTP オリジンとは異なるものにできます。Vite の開発サーバーをローカルで使用しつつ、Gateway を別の場所で実行する場合に便利です。

1. UI 開発サーバーを起動: `pnpm ui:dev`
2. 以下のような URL を開きます。

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

オプションのワンタイム認証（必要な場合）:

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

注意事項:

- `gatewayUrl` はロード後に localStorage に保存され、URL から削除されます。
- `token` は localStorage に保存されます。`password` はメモリのみに保持されます。
- `gatewayUrl` が設定されている場合、UI は設定や環境の認証情報にフォールバックしません。`token`（または `password`）を明示的に指定してください。明示的な認証情報がない場合はエラーになります。
- Gateway が TLS の背後にある場合（Tailscale Serve、HTTPS プロキシなど）は `wss://` を使用してください。
- `gatewayUrl` はクリックジャッキングを防ぐため、トップレベルウィンドウ（埋め込みではない）でのみ受け付けられます。
- ループバック以外のコントロール UI デプロイでは、`gateway.controlUi.allowedOrigins` を明示的に設定する必要があります（完全なオリジン）。リモート開発環境も含まれます。
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` は Host ヘッダーオリジンフォールバックモードを有効にしますが、危険なセキュリティモードです。

例:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

リモートアクセスの設定詳細: [リモートアクセス](/gateway/remote)
