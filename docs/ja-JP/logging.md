---
summary: "ロギングの概要: ファイルログ、コンソール出力、CLI テール、Control UI"
read_when:
  - ロギングの初心者向け概要が必要な場合
  - ログレベルやフォーマットを設定したい場合
  - トラブルシューティングでログを素早く見つける必要がある場合
title: "ロギング"
---

# ロギング

OpenClaw は 2 か所にログを記録します:

- Gateway が書き込む**ファイルログ**（JSON 行）。
- ターミナルと Control UI に表示される**コンソール出力**。

このページでは、ログの保存場所、読み方、ログレベルとフォーマットの設定方法を説明します。

## ログの保存場所

デフォルトでは、Gateway は以下にローリングログファイルを書き込みます:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日付は Gateway ホストのローカルタイムゾーンを使用します。

`~/.openclaw/openclaw.json` でこれをオーバーライドできます:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## ログの読み方

### CLI: ライブテール（推奨）

CLI を使用して RPC 経由で Gateway ログファイルをテールします:

```bash
openclaw logs --follow
```

出力モード:

- **TTY セッション**: きれいで色付きの構造化されたログライン。
- **非 TTY セッション**: プレーンテキスト。
- `--json`: 行区切り JSON（1 行に 1 ログイベント）。
- `--plain`: TTY セッションでプレーンテキストを強制。
- `--no-color`: ANSI カラーを無効化。

JSON モードでは、CLI は `type` タグ付きオブジェクトを出力します:

- `meta`: ストリームメタデータ（ファイル、カーソル、サイズ）
- `log`: パースされたログエントリ
- `notice`: 切り詰め/ローテーションのヒント
- `raw`: パースされていないログライン

Gateway に接続できない場合、CLI は以下を実行するための短いヒントを出力します:

```bash
openclaw doctor
```

### Control UI（Web）

Control UI の **Logs** タブは `logs.tail` を使用して同じファイルをテールします。
開き方については [/web/control-ui](/web/control-ui) を参照してください。

### チャンネルのみのログ

チャンネルアクティビティ（WhatsApp/Telegram など）をフィルタリングするには:

```bash
openclaw channels logs --channel whatsapp
```

## ログフォーマット

### ファイルログ（JSONL）

ログファイルの各行は JSON オブジェクトです。CLI と Control UI はこれらのエントリをパースして、構造化された出力（時間、レベル、サブシステム、メッセージ）をレンダリングします。

### コンソール出力

コンソールログは **TTY 対応**で、読みやすさのためにフォーマットされています:

- サブシステムプレフィックス（例: `gateway/channels/whatsapp`）
- レベルカラーリング（info/warn/error）
- オプションのコンパクトまたは JSON モード

コンソールフォーマットは `logging.consoleStyle` で制御されます。

## ロギングの設定

すべてのロギング設定は `~/.openclaw/openclaw.json` の `logging` に置かれます。

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### ログレベル

- `logging.level`: **ファイルログ**（JSONL）のレベル。
- `logging.consoleLevel`: **コンソール**の冗長度レベル。

**`OPENCLAW_LOG_LEVEL`** 環境変数（例: `OPENCLAW_LOG_LEVEL=debug`）で両方をオーバーライドできます。環境変数はコンフィグファイルよりも優先されるため、`openclaw.json` を編集することなく単一の実行の冗長度を上げることができます。また、グローバル CLI オプション **`--log-level <level>`**（例: `openclaw --log-level debug gateway run`）を渡すこともでき、このコマンドの環境変数をオーバーライドします。

`--verbose` はコンソール出力にのみ影響します。ファイルログレベルは変更されません。

### コンソールスタイル

`logging.consoleStyle`:

- `pretty`: 人間に優しく、色付き、タイムスタンプ付き。
- `compact`: よりタイトな出力（長時間セッションに最適）。
- `json`: 行ごとの JSON（ログプロセッサ向け）。

### リダクション

ツールサマリーはコンソールに表示される前にセンシティブなトークンをリダクションできます:

- `logging.redactSensitive`: `off` | `tools`（デフォルト: `tools`）
- `logging.redactPatterns`: デフォルトセットをオーバーライドするための正規表現文字列のリスト

リダクションは**コンソール出力のみ**に影響し、ファイルログは変更しません。

## 診断 + OpenTelemetry

診断はモデル実行**および**メッセージフローテレメトリ（Webhook、キューイング、セッション状態）のための構造化された機械可読イベントです。ログの代替ではなく、メトリクス、トレース、その他のエクスポーターにデータを供給するために存在します。

診断イベントはプロセス内で発行されますが、エクスポーターは診断 + エクスポーターのプラグインが有効な場合にのみアタッチされます。

### OpenTelemetry vs OTLP

- **OpenTelemetry（OTel）**: トレース、メトリクス、ログのためのデータモデル + SDK。
- **OTLP**: OTel データをコレクター/バックエンドにエクスポートするためのワイヤープロトコル。
- OpenClaw は現在 **OTLP/HTTP（protobuf）** 経由でエクスポートします。

### エクスポートされるシグナル

- **メトリクス**: カウンター + ヒストグラム（トークン使用量、メッセージフロー、キューイング）。
- **トレース**: モデル使用量 + Webhook/メッセージ処理のスパン。
- **ログ**: `diagnostics.otel.logs` が有効な場合、OTLP 経由でエクスポート。ログボリュームが多い場合があります。`logging.level` とエクスポーターフィルターを考慮してください。

### 診断イベントカタログ

モデル使用量:

- `model.usage`: トークン、コスト、期間、コンテキスト、プロバイダー/モデル/チャンネル、セッション ID。

メッセージフロー:

- `webhook.received`: チャンネルごとの Webhook 受信。
- `webhook.processed`: 処理された Webhook + 期間。
- `webhook.error`: Webhook ハンドラーエラー。
- `message.queued`: 処理のためにキューに入れられたメッセージ。
- `message.processed`: 結果 + 期間 + オプションのエラー。

キュー + セッション:

- `queue.lane.enqueue`: コマンドキューレーンのエンキュー + 深さ。
- `queue.lane.dequeue`: コマンドキューレーンのデキュー + 待機時間。
- `session.state`: セッション状態遷移 + 理由。
- `session.stuck`: セッションスタック警告 + 経過時間。
- `run.attempt`: 実行の再試行/試行メタデータ。
- `diagnostic.heartbeat`: 集計カウンター（Webhook/キュー/セッション）。

### 診断を有効にする（エクスポーターなし）

プラグインまたはカスタムシンクで診断イベントを利用可能にする場合:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診断フラグ（ターゲットログ）

`logging.level` を上げることなく、余分なターゲットデバッグログを有効にするためにフラグを使用します。
フラグは大文字小文字を区別せず、ワイルドカードをサポートします（例: `telegram.*` または `*`）。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

環境変数によるオーバーライド（一回限り）:

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

メモ:

- フラグログは標準ログファイルに記録されます（`logging.file` と同じ）。
- 出力は `logging.redactSensitive` に従ってリダクションされます。
- 完全なガイド: [/diagnostics/flags](/diagnostics/flags)。

### OpenTelemetry へのエクスポート

診断は `diagnostics-otel` プラグイン（OTLP/HTTP）経由でエクスポートできます。これは OTLP/HTTP を受け付ける任意の OpenTelemetry コレクター/バックエンドで動作します。

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

メモ:

- `openclaw plugins enable diagnostics-otel` でプラグインを有効にすることもできます。
- `protocol` は現在 `http/protobuf` のみをサポートします。`grpc` は無視されます。
- メトリクスにはトークン使用量、コスト、コンテキストサイズ、実行期間、メッセージフローカウンター/ヒストグラム（Webhook、キューイング、セッション状態、キュー深さ/待機時間）が含まれます。
- トレース/メトリクスは `traces` / `metrics` でトグルできます（デフォルト: on）。有効な場合、トレースにはモデル使用量スパンと Webhook/メッセージ処理スパンが含まれます。
- コレクターが認証を必要とする場合は `headers` を設定してください。
- サポートされる環境変数: `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### エクスポートされるメトリクス（名前 + タイプ）

モデル使用量:

- `openclaw.tokens`（カウンター、属性: `openclaw.token`、`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.cost.usd`（カウンター、属性: `openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.run.duration_ms`（ヒストグラム、属性: `openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.context.tokens`（ヒストグラム、属性: `openclaw.context`、`openclaw.channel`、`openclaw.provider`、`openclaw.model`）

メッセージフロー:

- `openclaw.webhook.received`（カウンター、属性: `openclaw.channel`、`openclaw.webhook`）
- `openclaw.webhook.error`（カウンター、属性: `openclaw.channel`、`openclaw.webhook`）
- `openclaw.webhook.duration_ms`（ヒストグラム、属性: `openclaw.channel`、`openclaw.webhook`）
- `openclaw.message.queued`（カウンター、属性: `openclaw.channel`、`openclaw.source`）
- `openclaw.message.processed`（カウンター、属性: `openclaw.channel`、`openclaw.outcome`）
- `openclaw.message.duration_ms`（ヒストグラム、属性: `openclaw.channel`、`openclaw.outcome`）

キュー + セッション:

- `openclaw.queue.lane.enqueue`（カウンター、属性: `openclaw.lane`）
- `openclaw.queue.lane.dequeue`（カウンター、属性: `openclaw.lane`）
- `openclaw.queue.depth`（ヒストグラム、属性: `openclaw.lane` または `openclaw.channel=heartbeat`）
- `openclaw.queue.wait_ms`（ヒストグラム、属性: `openclaw.lane`）
- `openclaw.session.state`（カウンター、属性: `openclaw.state`、`openclaw.reason`）
- `openclaw.session.stuck`（カウンター、属性: `openclaw.state`）
- `openclaw.session.stuck_age_ms`（ヒストグラム、属性: `openclaw.state`）
- `openclaw.run.attempt`（カウンター、属性: `openclaw.attempt`）

### エクスポートされるスパン（名前 + 主要属性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（input/output/cache_read/cache_write/total）
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、`openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、`openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、`openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、`openclaw.sessionKey`、`openclaw.sessionId`

### サンプリング + フラッシュ

- トレースサンプリング: `diagnostics.otel.sampleRate`（0.0〜1.0、ルートスパンのみ）。
- メトリクスエクスポート間隔: `diagnostics.otel.flushIntervalMs`（最小 1000ms）。

### プロトコルメモ

- OTLP/HTTP エンドポイントは `diagnostics.otel.endpoint` または `OTEL_EXPORTER_OTLP_ENDPOINT` で設定できます。
- エンドポイントにすでに `/v1/traces` または `/v1/metrics` が含まれている場合は、そのまま使用されます。
- エンドポイントにすでに `/v1/logs` が含まれている場合は、ログにそのまま使用されます。
- `diagnostics.otel.logs` はメインロガー出力の OTLP ログエクスポートを有効にします。

### ログエクスポートの動作

- OTLP ログは `logging.file` に書き込まれるのと同じ構造化レコードを使用します。
- `logging.level`（ファイルログレベル）を尊重します。コンソールリダクションは OTLP ログには**適用されません**。
- 大量インストールでは、OTLP コレクターのサンプリング/フィルタリングを優先してください。

## トラブルシューティングのヒント

- **Gateway に接続できない場合は？** まず `openclaw doctor` を実行してください。
- **ログが空の場合は？** Gateway が実行中で `logging.file` のファイルパスに書き込んでいることを確認してください。
- **詳細が必要な場合は？** `logging.level` を `debug` または `trace` に設定して再試行してください。
