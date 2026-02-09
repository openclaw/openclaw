---
summary: "ログの概要：ファイルログ、コンソール出力、CLI によるテーリング、Control UI"
read_when:
  - ログの初心者向け概要が必要なとき
  - ログレベルやフォーマットを設定したいとき
  - トラブルシューティングでログをすばやく見つけたいとき
title: "ログ"
---

# ログ

OpenClaw のログは、次の 2 か所に出力されます。

- **ファイルログ**（JSON Lines）：Gateway によって書き込まれます。
- **コンソール出力**：ターミナルおよび Control UI に表示されます。

このページでは、ログの保存場所、読み方、ログレベルやフォーマットの設定方法を説明します。

## ログの保存場所

デフォルトでは、Gateway は次の場所にローテーションされるログファイルを書き込みます。

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日付は、ゲートウェイ ホストのローカルタイムゾーンが使用されます。

この設定は、`~/.openclaw/openclaw.json` で上書きできます。

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## ログの読み方

### CLI：ライブテール（推奨）

CLI を使用して、RPC 経由でゲートウェイのログファイルをテールします。

```bash
openclaw logs --follow
```

出力モード：

- **TTY セッション**：整形済み、カラー表示、構造化されたログ行。
- **非 TTY セッション**：プレーンテキスト。
- `--json`：行区切りの JSON（1 行につき 1 つのログイベント）。
- `--plain`：TTY セッションでもプレーンテキストを強制。
- `--no-color`：ANSI カラーを無効化。

JSON モードでは、CLI は `type` タグ付きのオブジェクトを出力します。

- `meta`：ストリームのメタデータ（ファイル、カーソル、サイズ）
- `log`：解析済みのログエントリ
- `notice`：切り詰め／ローテーションのヒント
- `raw`：未解析のログ行

Gateway に到達できない場合、CLI は次を実行するための短いヒントを表示します。

```bash
openclaw doctor
```

### Control UI（Web）

Control UI の **Logs** タブは、`logs.tail` を使用して同じファイルをテールします。
開き方については [/web/control-ui](/web/control-ui) を参照してください。
開く方法は [/web/control-ui](/web/control-ui) をご覧ください。

### チャンネル専用ログ

チャンネルのアクティビティ（WhatsApp／Telegram など）をフィルタリングするには、次を使用します。

```bash
openclaw channels logs --channel whatsapp
```

## ログフォーマット

### ファイルログ（JSONL）

ログファイルの各行は JSON オブジェクトです。CLI と Control UI は、これらのエントリを解析して、構造化された出力（時刻、レベル、サブシステム、メッセージ）を描画します。 CLI と Control UI は、これらの
エントリを解析して、構造化された出力 (時間、レベル、サブシステム、メッセージ) をレンダリングします。

### コンソール出力

コンソールログは **TTY 対応** で、可読性を重視してフォーマットされます。

- サブシステムのプレフィックス（例：`gateway/channels/whatsapp`）
- レベルごとの色分け（info／warn／error）
- 省略表示または JSON モード（任意）

コンソールのフォーマットは `logging.consoleStyle` で制御されます。

## ログの設定

すべてのログ設定は、`~/.openclaw/openclaw.json` 内の `logging` にあります。

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

- `logging.level`：**ファイルログ**（JSONL）のレベル。
- `logging.consoleLevel`：**コンソール**の詳細度レベル。

`--verbose` はコンソール出力にのみ影響し、ファイルログのレベルは変更しません。

### コンソールスタイル

`logging.consoleStyle`：

- `pretty`：人に優しい表示、カラー付き、タイムスタンプあり。
- `compact`：より簡潔な出力（長時間セッションに最適）。
- `json`：1 行 1 JSON（ログ処理向け）。

### Redaction

ツールのサマリーは、コンソールに出力される前に機密トークンをマスキングできます。

- `logging.redactSensitive`：`off` | `tools`（デフォルト：`tools`）
- `logging.redactPatterns`：デフォルトセットを上書きするための正規表現文字列のリスト

マスキングは **コンソール出力のみに影響** し、ファイルログは変更しません。

## 診断 + OpenTelemetry

診断は、モデル実行 **および** メッセージフローのテレメトリ（Webhook、キューイング、セッション状態）向けの、構造化された機械可読イベントです。ログを **置き換えるものではありません**。メトリクス、トレース、その他のエクスポーターに供給するために存在します。 これらは \*\*
ログを置き換えません。メトリック、トレース、およびその他のエクスポーターにフィードするために存在します。

診断イベントはプロセス内で発行されますが、エクスポーターは、診断とエクスポータープラグインの両方が有効な場合にのみ接続されます。

### OpenTelemetry と OTLP の違い

- **OpenTelemetry（OTel）**：トレース、メトリクス、ログのデータモデルと SDK。
- **OTLP**：OTel データをコレクター／バックエンドへエクスポートするためのワイヤープロトコル。
- OpenClaw は現在、**OTLP/HTTP（protobuf）** でエクスポートします。

### エクスポートされるシグナル

- **メトリクス**：カウンターとヒストグラム（トークン使用量、メッセージフロー、キューイング）。
- **トレース**：モデル使用と Webhook／メッセージ処理のスパン。
- **ログ**：`diagnostics.otel.logs` が有効な場合に OTLP 経由でエクスポート。ログ量が多くなる可能性があるため、`logging.level` とエクスポーターのフィルターを考慮してください。 ログ
  のボリュームは高くなります。`logging.level`とエクスポーターフィルターに留意してください。

### 診断イベントのカタログ

モデル使用量：

- `model.usage`：トークン、コスト、所要時間、コンテキスト、プロバイダー／モデル／チャンネル、セッション ID。

メッセージフロー：

- `webhook.received`：チャンネルごとの Webhook 受信。
- `webhook.processed`：Webhook の処理完了と所要時間。
- `webhook.error`：Webhook ハンドラーのエラー。
- `message.queued`：処理キューに投入されたメッセージ。
- `message.processed`：結果、所要時間、任意のエラー。

キュー + セッション：

- `queue.lane.enqueue`：コマンドキュー レーンのエンキューと深さ。
- `queue.lane.dequeue`：コマンドキュー レーンのデキューと待ち時間。
- `session.state`：セッション状態遷移と理由。
- `session.stuck`：セッション停滞の警告と経過時間。
- `run.attempt`：実行の再試行／試行回数のメタデータ。
- `diagnostic.heartbeat`：集計カウンター（Webhook／キュー／セッション）。

### 診断を有効化（エクスポーターなし）

診断イベントをプラグインやカスタムシンクで利用したい場合に使用します。

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診断フラグ（ターゲット指定ログ）

`logging.level` を引き上げずに、追加のターゲット指定デバッグログを有効化するにはフラグを使用します。
フラグは大文字小文字を区別せず、ワイルドカードをサポートします（例：`telegram.*` または `*`）。
フラグは大文字と小文字を区別せず、ワイルドカードをサポートします(例: `telegram.*` や `*` )。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env オーバーライド(one-off):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

注記：

- フラグログは標準のログファイル（`logging.file` と同じ）に出力されます。
- 出力は `logging.redactSensitive` に従って引き続きマスキングされます。
- 完全ガイド：[/diagnostics/flags](/diagnostics/flags)。

### OpenTelemetry へのエクスポート

診断は、`diagnostics-otel` プラグイン（OTLP/HTTP）を介してエクスポートできます。
OTLP/HTTP を受け付ける任意の OpenTelemetry コレクター／バックエンドで動作します。 この
は、OTLP/HTTP を受け入れる任意の OpenTelemetry コレクタ/バックエンドで動作します。

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

注記：

- `openclaw plugins enable diagnostics-otel` を使用してプラグインを有効化することもできます。
- `protocol` は現在 `http/protobuf` のみをサポートします。`grpc` は無視されます。 `grpc` は無視されます。
- メトリクスには、トークン使用量、コスト、コンテキストサイズ、実行時間、およびメッセージフローのカウンター／ヒストグラム（Webhook、キューイング、セッション状態、キュー深度／待ち時間）が含まれます。
- トレース/メトリックは `traces` / `metrics` で切り替えることができます(デフォルト: on)。 トレース／メトリクスは `traces`／`metrics` で切り替え可能（デフォルト：有効）。トレースには、モデル使用のスパンに加え、有効時は Webhook／メッセージ処理のスパンが含まれます。
- コレクターで認証が必要な場合は `headers` を設定してください。
- 対応する環境変数：`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### エクスポートされるメトリクス（名前 + 型）

モデル使用量：

- `openclaw.tokens`（counter、属性：`openclaw.token`、`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`）
- `openclaw.cost.usd`（counter、属性：`openclaw.channel`、`openclaw.provider`、
  `openclaw.model`）
- `openclaw.run.duration_ms`（histogram、属性：`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`）
- `openclaw.context.tokens`（histogram、属性：`openclaw.context`、
  `openclaw.channel`、`openclaw.provider`、`openclaw.model`）

メッセージフロー：

- `openclaw.webhook.received`（counter、属性：`openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.webhook.error`（counter、属性：`openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.webhook.duration_ms`（histogram、属性：`openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.message.queued`（counter、属性：`openclaw.channel`、
  `openclaw.source`）
- `openclaw.message.processed`（counter、属性：`openclaw.channel`、
  `openclaw.outcome`）
- `openclaw.message.duration_ms`（histogram、属性：`openclaw.channel`、
  `openclaw.outcome`）

キュー + セッション：

- `openclaw.queue.lane.enqueue`（counter、属性：`openclaw.lane`）
- `openclaw.queue.lane.dequeue`（counter、属性：`openclaw.lane`）
- `openclaw.queue.depth`（histogram、属性：`openclaw.lane` または
  `openclaw.channel=heartbeat`）
- `openclaw.queue.wait_ms`（histogram、属性：`openclaw.lane`）
- `openclaw.session.state`（counter、属性：`openclaw.state`、`openclaw.reason`）
- `openclaw.session.stuck`（counter、属性：`openclaw.state`）
- `openclaw.session.stuck_age_ms`（histogram、属性：`openclaw.state`）
- `openclaw.run.attempt`（counter、属性：`openclaw.attempt`）

### エクスポートされるスパン（名前 + 主要属性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（input／output／cache_read／cache_write／total）
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、
    `openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、
    `openclaw.sessionKey`、`openclaw.sessionId`

### サンプリング + フラッシュ

- トレースのサンプリング：`diagnostics.otel.sampleRate`（0.0～1.0、ルートスパンのみ）。
- メトリクスのエクスポート間隔：`diagnostics.otel.flushIntervalMs`（最小 1000ms）。

### プロトコルに関する注記

- OTLP/HTTP のエンドポイントは `diagnostics.otel.endpoint` または
  `OTEL_EXPORTER_OTLP_ENDPOINT` で設定できます。
- エンドポイントに既に `/v1/traces` または `/v1/metrics` が含まれている場合、そのまま使用されます。
- エンドポイントに既に `/v1/logs` が含まれている場合、ログ用としてそのまま使用されます。
- `diagnostics.otel.logs` は、メインロガー出力の OTLP ログエクスポートを有効化します。

### ログのエクスポート動作

- OTLP ログは、`logging.file` に書き込まれるのと同じ構造化レコードを使用します。
- `logging.level` (ファイルログレベル) を尊重します。 `logging.level`（ファイルログレベル）を尊重します。コンソールのマスキングは OTLP ログには **適用されません**。
- 高ボリュームの環境では、OTLP コレクター側のサンプリング／フィルタリングを推奨します。

## トラブルシューティングのヒント

- **Gateway に到達できませんか？** まず `openclaw doctor` を実行してください。
- **ログが空ですか？** Gateway が実行中で、`logging.file` にあるファイルパスへ書き込んでいることを確認してください。
- **より詳細が必要ですか？** `logging.level` を `debug` または `trace` に設定して再試行してください。
