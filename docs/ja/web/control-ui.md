---
summary: "Gateway（ゲートウェイ）向けのブラウザベース制御 UI（チャット、ノード、設定）"
read_when:
  - ブラウザから Gateway を操作したい場合
  - SSH トンネルなしで Tailnet アクセスを利用したい場合
title: "Control UI"
x-i18n:
  source_path: web/control-ui.md
  source_hash: baaaf73820f0e703
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:54Z
---

# Control UI（ブラウザ）

Control UI は、Gateway によって提供される小さな **Vite + Lit** のシングルページアプリです。

- デフォルト: `http://<host>:18789/`
- オプションのプレフィックス: `gateway.controlUi.basePath` を設定（例: `/openclaw`）

同一ポート上の **Gateway WebSocket** と **直接** 通信します。

## クイックオープン（ローカル）

Gateway が同じコンピュータで実行されている場合、次を開きます。

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/)（または [http://localhost:18789/](http://localhost:18789/)）

ページが読み込まれない場合は、先に Gateway を起動してください: `openclaw gateway`。

認証は WebSocket ハンドシェイク時に次の方法で提供されます。

- `connect.params.auth.token`
- `connect.params.auth.password`
  ダッシュボードの設定パネルではトークンを保存できます。パスワードは永続化されません。
  オンボーディングウィザードはデフォルトで ゲートウェイ トークンを生成するため、初回接続時にここへ貼り付けてください。

## デバイスのペアリング（初回接続）

新しいブラウザやデバイスから Control UI に接続すると、Gateway は **一度限りのペアリング承認** を要求します。`gateway.auth.allowTailscale: true` と同じ Tailnet 上にいる場合でも必要です。これは不正アクセスを防ぐためのセキュリティ対策です。

**表示される内容:** 「disconnected (1008): pairing required」

**デバイスを承認するには:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

承認されると、そのデバイスは記憶され、`openclaw devices revoke --device <id> --role <role>` で失効させない限り再承認は不要です。トークンのローテーションと失効については [Devices CLI](/cli/devices) を参照してください。

**注記:**

- ローカル接続（`127.0.0.1`）は自動承認されます。
- リモート接続（LAN、Tailnet など）は明示的な承認が必要です。
- 各ブラウザプロファイルは一意のデバイス ID を生成するため、ブラウザの切り替えやブラウザデータの消去を行うと再ペアリングが必要になります。

## できること（現時点）

- Gateway WS を介したモデルとのチャット（`chat.history`、`chat.send`、`chat.abort`、`chat.inject`）
- チャット内でのツール呼び出しのストリーミングとライブツール出力カード（エージェントイベント）
- チャンネル: WhatsApp/Telegram/Discord/Slack + プラグインチャンネル（Mattermost など）のステータス、QR ログイン、チャンネルごとの設定（`channels.status`、`web.login.*`、`config.patch`）
- インスタンス: プレゼンス一覧 + 更新（`system-presence`）
- セッション: 一覧 + セッションごとの thinking/verbose 上書き（`sessions.list`、`sessions.patch`）
- Cron ジョブ: 一覧/追加/実行/有効化/無効化 + 実行履歴（`cron.*`）
- Skills: ステータス、有効化/無効化、インストール、API キー更新（`skills.*`）
- ノード: 一覧 + 機能（`node.list`）
- 実行承認: ゲートウェイまたはノードの許可リスト編集 + `exec host=gateway/node` に対するポリシー問い合わせ（`exec.approvals.*`）
- 設定: `~/.openclaw/openclaw.json` の表示/編集（`config.get`、`config.set`）
- 設定: 検証付きで適用 + 再起動（`config.apply`）および最後にアクティブだったセッションの復帰
- 設定書き込みには、同時編集の上書きを防ぐためのベースハッシュガードを含みます
- 設定スキーマ + フォームレンダリング（プラグインおよびチャンネルのスキーマを含む `config.schema`）。Raw JSON エディターも引き続き利用可能
- デバッグ: ステータス/ヘルス/モデルのスナップショット + イベントログ + 手動 RPC 呼び出し（`status`、`health`、`models.list`）
- ログ: フィルター/エクスポート付きの ゲートウェイ ファイルログのライブ追尾（`logs.tail`）
- 更新: パッケージ/ git 更新の実行 + 再起動（`update.run`）と再起動レポート

Cron ジョブパネルの注記:

- 分離されたジョブでは、配信はデフォルトで要約のアナウンスになります。内部実行のみとしたい場合は none に切り替えられます。
- announce を選択すると、チャンネル/ターゲットのフィールドが表示されます。

## チャットの挙動

- `chat.send` は **ノンブロッキング** です。`{ runId, status: "started" }` で即時に ACK され、応答は `chat` イベントでストリーム配信されます。
- 同じ `idempotencyKey` で再送信すると、実行中は `{ status: "in_flight" }`、完了後は `{ status: "ok" }` が返ります。
- `chat.inject` はセッションのトランスクリプトにアシスタントノートを追加し、UI 専用更新のために `chat` イベントをブロードキャストします（エージェント実行なし、チャンネル配信なし）。
- 停止:
  - **Stop** をクリック（`chat.abort` を呼び出し）
  - `/stop`（または `stop|esc|abort|wait|exit|interrupt`）と入力してアウトオブバンドで中断
  - `chat.abort` は `{ sessionKey }` をサポートします（`runId` なし）— そのセッションのすべてのアクティブ実行を中断します

## Tailnet アクセス（推奨）

### 統合 Tailscale Serve（推奨）

Gateway を loopback に保ち、Tailscale Serve で HTTPS プロキシします。

```bash
openclaw gateway --tailscale serve
```

次を開きます。

- `https://<magicdns>/`（または設定した `gateway.controlUi.basePath`）

デフォルトでは、Serve のリクエストは `gateway.auth.allowTailscale` が `true` の場合、Tailscale の ID ヘッダー（`tailscale-user-login`）で認証できます。OpenClaw は `tailscale whois` を用いて `x-forwarded-for` アドレスを解決し、ヘッダーと一致することを検証します。また、リクエストが loopback に到達し、Tailscale の `x-forwarded-*` ヘッダーがある場合にのみこれらを受け入れます。Serve トラフィックであってもトークン/パスワードを必須にしたい場合は、`gateway.auth.allowTailscale: false` を設定するか `gateway.auth.mode: "password"` を強制してください。

### tailnet にバインド + トークン

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

次に開きます。

- `http://<tailscale-ip>:18789/`（または設定した `gateway.controlUi.basePath`）

UI 設定にトークンを貼り付けてください（`connect.params.auth.token` として送信されます）。

## 非セキュア HTTP

プレーン HTTP（`http://<lan-ip>` または `http://<tailscale-ip>`）でダッシュボードを開くと、ブラウザは **非セキュアコンテキスト** で実行され、WebCrypto がブロックされます。デフォルトでは、OpenClaw はデバイス ID なしの Control UI 接続を **ブロック** します。

**推奨される対処:** HTTPS（Tailscale Serve）を使用するか、UI をローカルで開いてください。

- `https://<magicdns>/`（Serve）
- `http://127.0.0.1:18789/`（ゲートウェイ ホスト上）

**ダウングレード例（HTTP 上でのトークンのみ）:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

これにより、Control UI のデバイス ID とペアリングが無効になります（HTTPS 上でも）。ネットワークを信頼できる場合にのみ使用してください。

HTTPS のセットアップ手順については [Tailscale](/gateway/tailscale) を参照してください。

## UI のビルド

Gateway は `dist/control-ui` から静的ファイルを提供します。次でビルドしてください。

```bash
pnpm ui:build # auto-installs UI deps on first run
```

オプションの絶対ベース（固定アセット URL を使用したい場合）:

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

ローカル開発（別の開発サーバー）:

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

その後、UI を Gateway WS URL（例: `ws://127.0.0.1:18789`）に向けてください。

## デバッグ/テスト: 開発サーバー + リモート Gateway

Control UI は静的ファイルであり、WebSocket の接続先は設定可能で、HTTP のオリジンと異なっていても構いません。これは、Vite の開発サーバーをローカルで使用し、Gateway を別の場所で実行したい場合に便利です。

1. UI の開発サーバーを起動: `pnpm ui:dev`
2. 次のような URL を開きます。

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

必要に応じた一度限りの認証:

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

注記:

- `gatewayUrl` は読み込み後に localStorage に保存され、URL から削除されます。
- `token` は localStorage に保存されます。`password` はメモリ内のみに保持されます。
- `gatewayUrl` が設定されている場合、UI は設定や環境変数の認証情報へフォールバックしません。
  `token`（または `password`）を明示的に指定してください。明示的な認証情報がない場合はエラーになります。
- Gateway が TLS（Tailscale Serve、HTTPS プロキシなど）の背後にある場合は `wss://` を使用してください。
- `gatewayUrl` はクリックジャッキング防止のため、トップレベルウィンドウでのみ受け付けられます（埋め込み不可）。
- クロスオリジンの開発セットアップ（例: `pnpm ui:dev` からリモート Gateway）では、UI のオリジンを `gateway.controlUi.allowedOrigins` に追加してください。

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

リモートアクセスの設定詳細: [Remote access](/gateway/remote)。
