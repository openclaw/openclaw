---
read_when:
    - ロギングの初心者向け概要が必要な場合
    - ログレベルやフォーマットを設定したい場合
    - トラブルシューティング中にログをすばやく見つける必要がある場合
summary: 'ロギング概要: ファイルログ、コンソール出力、CLIテーリング、およびControl UI'
title: ロギング概要
x-i18n:
    generated_at: "2026-04-02T07:46:43Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: b0370a607dc774a734929a53d43593a0857584d2c117e5d9f0180ee5a79fa258
    source_path: logging.md
    workflow: 15
---

# ロギング

OpenClawは2か所にログを記録します:

- **ファイルログ**（JSONライン）: Gateway ゲートウェイが書き込みます。
- **コンソール出力**: ターミナルおよびControl UIに表示されます。

このページでは、ログの保存場所、ログの読み方、ログレベルとフォーマットの設定方法について説明します。

## ログの保存場所

デフォルトでは、Gateway ゲートウェイは以下のパスにローリングログファイルを書き込みます:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日付はGateway ゲートウェイホストのローカルタイムゾーンを使用します。

`~/.openclaw/openclaw.json` でオーバーライドできます:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## ログの読み方

### CLI: ライブテール（推奨）

CLIを使用して、RPC経由でGateway ゲートウェイのログファイルをテールします:

```bash
openclaw logs --follow
```

出力モード:

- **TTYセッション**: 構造化されたログ行がカラー付きできれいに表示されます。
- **非TTYセッション**: プレーンテキスト。
- `--json`: 行区切りJSON（1行に1つのログイベント）。
- `--plain`: TTYセッションでプレーンテキストを強制します。
- `--no-color`: ANSIカラーを無効にします。

JSONモードでは、CLIは `type` タグ付きオブジェクトを出力します:

- `meta`: ストリームメタデータ（ファイル、カーソル、サイズ）
- `log`: パース済みログエントリ
- `notice`: 切り捨て / ローテーションのヒント
- `raw`: 未パースのログ行

Gateway ゲートウェイに接続できない場合、CLIは以下を実行するよう短いヒントを表示します:

```bash
openclaw doctor
```

### Control UI（ウェブ）

Control UIの**ログ**タブは、`logs.tail` を使用して同じファイルをテールします。
開き方については [/web/control-ui](/web/control-ui) を参照してください。

### チャネル専用ログ

チャネルアクティビティ（WhatsApp/Telegramなど）をフィルタリングするには、以下を使用します:

```bash
openclaw channels logs --channel whatsapp
```

## ログフォーマット

### ファイルログ（JSONL）

ログファイルの各行はJSONオブジェクトです。CLIとControl UIはこれらのエントリをパースして、構造化された出力（時刻、レベル、サブシステム、メッセージ）をレンダリングします。

### コンソール出力

コンソールログは**TTY対応**で、読みやすくフォーマットされています:

- サブシステムプレフィックス（例: `gateway/channels/whatsapp`）
- レベルカラーリング（info/warn/error）
- オプションのコンパクトまたはJSONモード

コンソールフォーマットは `logging.consoleStyle` で制御されます。

## ロギングの設定

すべてのロギング設定は、`~/.openclaw/openclaw.json` の `logging` 以下にあります。

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
- `logging.consoleLevel`: **コンソール**の詳細度レベル。

どちらも**`OPENCLAW_LOG_LEVEL`** 環境変数でオーバーライドできます（例: `OPENCLAW_LOG_LEVEL=debug`）。環境変数は設定ファイルより優先されるため、`openclaw.json` を編集せずに1回の実行だけ詳細度を上げることができます。また、グローバルCLIオプション **`--log-level <level>`**（例: `openclaw --log-level debug gateway run`）を渡すこともでき、そのコマンドに対して環境変数をオーバーライドします。

`--verbose` はコンソール出力にのみ影響し、ファイルログレベルは変更しません。

### コンソールスタイル

`logging.consoleStyle`:

- `pretty`: 人間にやさしく、カラー付きで、タイムスタンプ付き。
- `compact`: よりコンパクトな出力（長時間セッションに最適）。
- `json`: 1行ごとにJSON（ログプロセッサ向け）。

### リダクション

ツールサマリーは、コンソールに出力される前に機密トークンをリダクションできます:

- `logging.redactSensitive`: `off` | `tools`（デフォルト: `tools`）
- `logging.redactPatterns`: デフォルトセットをオーバーライドする正規表現文字列のリスト

リダクションは**コンソール出力にのみ**影響し、ファイルログは変更しません。

## 診断 + OpenTelemetry

診断は、モデル実行**および**メッセージフローテレメトリ（Webhook、キューイング、セッション状態）のための、構造化されたマシンリーダブルなイベントです。ログを置き換えるものでは**ありません**。メトリクス、トレース、その他のエクスポーターにデータを供給するために存在します。

診断イベントはインプロセスで発行されますが、エクスポーターは診断とエクスポータープラグインの両方が有効な場合にのみアタッチされます。

### OpenTelemetryとOTLP

- **OpenTelemetry（OTel）**: トレース、メトリクス、ログのためのデータモデル + SDK。
- **OTLP**: OTelデータをコレクター/バックエンドにエクスポートするために使用されるワイヤプロトコル。
- OpenClawは現在 **OTLP/HTTP（protobuf）** でエクスポートします。

### エクスポートされるシグナル

- **メトリクス**: カウンター + ヒストグラム（トークン使用量、メッセージフロー、キューイング）。
- **トレース**: モデル使用量 + Webhook/メッセージ処理のスパン。
- **ログ**: `diagnostics.otel.logs` が有効な場合、OTLPでエクスポートされます。ログ量は多くなる可能性があります。`logging.level` とエクスポーターフィルターに注意してください。

### 診断イベントカタログ

モデル使用量:

- `model.usage`: トークン、コスト、所要時間、コンテキスト、プロバイダー/モデル/チャネル、セッションID。

メッセージフロー:

- `webhook.received`: チャネルごとのWebhook受信。
- `webhook.processed`: Webhook処理完了 + 所要時間。
- `webhook.error`: Webhookハンドラーエラー。
- `message.queued`: 処理のためにキューに追加されたメッセージ。
- `message.processed`: 結果 + 所要時間 + オプションのエラー。

キュー + セッション:

- `queue.lane.enqueue`: コマンドキューレーンへのエンキュー + 深さ。
- `queue.lane.dequeue`: コマンドキューレーンからのデキュー + 待機時間。
- `session.state`: セッション状態の遷移 + 理由。
- `session.stuck`: セッションスタック警告 + 経過時間。
- `run.attempt`: 実行リトライ/試行メタデータ。
- `diagnostic.heartbeat`: 集計カウンター（Webhook/キュー/セッション）。

### 診断の有効化（エクスポーターなし）

診断イベントをプラグインやカスタムシンクで利用可能にしたい場合に使用します:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診断フラグ（ターゲットログ）

`logging.level` を上げずに、追加のターゲットデバッグログを有効にするためにフラグを使用します。
フラグは大文字小文字を区別せず、ワイルドカードをサポートします（例: `telegram.*` や `*`）。

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

注意事項:

- フラグログは標準ログファイルに出力されます（`logging.file` と同じ）。
- 出力は `logging.redactSensitive` に従ってリダクションされます。
- 詳細ガイド: [/diagnostics/flags](/diagnostics/flags)。

### OpenTelemetryへのエクスポート

診断は `diagnostics-otel` プラグイン（OTLP/HTTP）を使用してエクスポートできます。OTLP/HTTPを受け付ける任意のOpenTelemetryコレクター/バックエンドで動作します。

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

注意事項:

- `openclaw plugins enable diagnostics-otel` でもプラグインを有効にできます。
- `protocol` は現在 `http/protobuf` のみサポートしています。`grpc` は無視されます。
- メトリクスにはトークン使用量、コスト、コンテキストサイズ、実行時間、およびメッセージフローのカウンター/ヒストグラム（Webhook、キューイング、セッション状態、キュー深さ/待機時間）が含まれます。
- トレース/メトリクスは `traces` / `metrics` で切り替えできます（デフォルト: オン）。トレースが有効な場合、モデル使用量スパンに加えてWebhook/メッセージ処理スパンが含まれます。
- コレクターが認証を必要とする場合は `headers` を設定してください。
- サポートされる環境変数: `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### エクスポートされるメトリクス（名前 + 型）

モデル使用量:

- `openclaw.tokens`（counter、属性: `openclaw.token`、`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`）
- `openclaw.cost.usd`（counter、属性: `openclaw.channel`、`openclaw.provider`、
  `openclaw.model`）
- `openclaw.run.duration_ms`（histogram、属性: `openclaw.channel`、
  `openclaw.provider`、`openclaw.model`）
- `openclaw.context.tokens`（histogram、属性: `openclaw.context`、
  `openclaw.channel`、`openclaw.provider`、`openclaw.model`）

メッセージフロー:

- `openclaw.webhook.received`（counter、属性: `openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.webhook.error`（counter、属性: `openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.webhook.duration_ms`（histogram、属性: `openclaw.channel`、
  `openclaw.webhook`）
- `openclaw.message.queued`（counter、属性: `openclaw.channel`、
  `openclaw.source`）
- `openclaw.message.processed`（counter、属性: `openclaw.channel`、
  `openclaw.outcome`）
- `openclaw.message.duration_ms`（histogram、属性: `openclaw.channel`、
  `openclaw.outcome`）

キュー + セッション:

- `openclaw.queue.lane.enqueue`（counter、属性: `openclaw.lane`）
- `openclaw.queue.lane.dequeue`（counter、属性: `openclaw.lane`）
- `openclaw.queue.depth`（histogram、属性: `openclaw.lane` または
  `openclaw.channel=heartbeat`）
- `openclaw.queue.wait_ms`（histogram、属性: `openclaw.lane`）
- `openclaw.session.state`（counter、属性: `openclaw.state`、`openclaw.reason`）
- `openclaw.session.stuck`（counter、属性: `openclaw.state`）
- `openclaw.session.stuck_age_ms`（histogram、属性: `openclaw.state`）
- `openclaw.run.attempt`（counter、属性: `openclaw.attempt`）

### エクスポートされるスパン（名前 + 主要属性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（input/output/cache_read/cache_write/total）
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

- トレースサンプリング: `diagnostics.otel.sampleRate`（0.0〜1.0、ルートスパンのみ）。
- メトリクスエクスポート間隔: `diagnostics.otel.flushIntervalMs`（最小1000ms）。

### プロトコルに関する注意事項

- OTLP/HTTPエンドポイントは `diagnostics.otel.endpoint` または
  `OTEL_EXPORTER_OTLP_ENDPOINT` で設定できます。
- エンドポイントにすでに `/v1/traces` や `/v1/metrics` が含まれている場合、そのまま使用されます。
- エンドポイントにすでに `/v1/logs` が含まれている場合、ログにはそのまま使用されます。
- `diagnostics.otel.logs` はメインロガー出力のOTLPログエクスポートを有効にします。

### ログエクスポートの動作

- OTLPログは `logging.file` に書き込まれるものと同じ構造化レコードを使用します。
- `logging.level`（ファイルログレベル）を尊重します。コンソールのリダクションはOTLPログには適用**されません**。
- 大量のインストール環境では、OTLPコレクター側でのサンプリング/フィルタリングを推奨します。

## トラブルシューティングのヒント

- **Gateway ゲートウェイに接続できない場合:** まず `openclaw doctor` を実行してください。
- **ログが空の場合:** Gateway ゲートウェイが稼働中で、`logging.file` のファイルパスに書き込んでいるか確認してください。
- **詳細が必要な場合:** `logging.level` を `debug` または `trace` に設定して再試行してください。

## 関連

- [Gateway ゲートウェイのロギング内部構造](/gateway/logging) — WSログスタイル、サブシステムプレフィックス、コンソールキャプチャ
- [診断](/gateway/configuration-reference#diagnostics) — OpenTelemetryエクスポートとキャッシュトレース設定
