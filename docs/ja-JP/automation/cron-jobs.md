---
summary: "Gateway スケジューラー向けの Cronジョブとウェイクアップ"
read_when:
  - バックグラウンドジョブやウェイクアップをスケジューリングするとき
  - ハートビートと連携して動作する自動化を組み込むとき
  - スケジュールタスクにハートビートと Cron のどちらを使うか検討するとき
title: "Cronジョブ"
---

# Cronジョブ（Gateway スケジューラー）

> **Cron とハートビートの使い分け?** [Cron vs ハートビート](/automation/cron-vs-heartbeat) を参照してください。

Cron は Gateway に内蔵されたスケジューラーです。ジョブを永続化し、適切なタイミングでエージェントを起動し、オプションで出力をチャットに返すことができます。

_「毎朝実行する」_ や _「20分後にエージェントを呼び出す」_ という場合は、Cron を使用してください。

トラブルシューティング: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron は **Gateway の内部**で動作します（モデルの内部ではありません）。
- ジョブは `~/.openclaw/cron/` に保存されるため、再起動してもスケジュールは失われません。
- 2 つの実行スタイル:
  - **メインセッション**: システムイベントをキューに追加し、次のハートビートで実行します。
  - **アイソレーテッド**: `cron:<jobId>` で専用のエージェントターンを実行し、デリバリーします（デフォルトはアナウンス、またはなし）。
- ウェイクアップはファーストクラスです。ジョブは「今すぐウェイク」または「次のハートビート」をリクエストできます。
- Webhook の投稿はジョブごとに `delivery.mode = "webhook"` + `delivery.to = "<url>"` で設定します。
- `notify: true` が設定された保存済みの旧ジョブは `cron.webhook` への投稿をフォールバックとして維持します（設定されている場合）。これらのジョブは Webhook デリバリーモードに移行してください。

## クイックスタート（実践的）

ワンショットリマインダーを作成し、存在を確認してすぐに実行します:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

デリバリー付きの繰り返しアイソレーテッドジョブをスケジュールします:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## ツールコール相当（Gateway cron ツール）

正規の JSON 形状と例については、[ツールコール用 JSON スキーマ](/automation/cron-jobs#json-schema-for-tool-calls) を参照してください。

## Cronジョブの保存場所

Cronジョブはデフォルトで Gateway ホストの `~/.openclaw/cron/jobs.json` に保存されます。Gateway はファイルをメモリに読み込み、変更時に書き戻します。手動での編集は Gateway が停止しているときのみ安全です。変更には `openclaw cron add/edit` または cron ツールコール API を使用してください。

## 初心者向け概要

Cronジョブを「**いつ**実行するか + **何を**するか」と考えてください。

1. **スケジュールを選ぶ**
   - ワンショットリマインダー → `schedule.kind = "at"`（CLI: `--at`）
   - 繰り返しジョブ → `schedule.kind = "every"` または `schedule.kind = "cron"`
   - タイムゾーンを省略した ISO タイムスタンプは **UTC** として扱われます。

2. **実行場所を選ぶ**
   - `sessionTarget: "main"` → メインコンテキストで次のハートビート時に実行。
   - `sessionTarget: "isolated"` → `cron:<jobId>` で専用のエージェントターンを実行。

3. **ペイロードを選ぶ**
   - メインセッション → `payload.kind = "systemEvent"`
   - アイソレーテッドセッション → `payload.kind = "agentTurn"`

オプション: ワンショットジョブ（`schedule.kind = "at"`）は成功後にデフォルトで削除されます。保持する場合は `deleteAfterRun: false` を設定してください（成功後に無効化されます）。

## コンセプト

### ジョブ

Cronジョブは以下を含む保存されたレコードです:

- **スケジュール**（いつ実行するか）
- **ペイロード**（何をするか）
- オプションの**デリバリーモード**（`announce`、`webhook`、または `none`）
- オプションの**エージェントバインディング**（`agentId`）: 特定のエージェントでジョブを実行します。存在しないか不明な場合は、Gateway がデフォルトエージェントにフォールバックします。

ジョブは安定した `jobId`（CLI/Gateway API で使用）で識別されます。エージェントツールコールでは `jobId` が正規形式です。レガシーの `id` は互換性のために受け入れられます。ワンショットジョブは成功後にデフォルトで自動削除されます。保持する場合は `deleteAfterRun: false` を設定してください。

### スケジュール

Cron は3つのスケジュール種別をサポートします:

- `at`: `schedule.at`（ISO 8601）によるワンショットタイムスタンプ。
- `every`: 固定間隔（ミリ秒）。
- `cron`: 5フィールドの cron 式（または秒付きの6フィールド）とオプションの IANA タイムゾーン。

Cron 式には `croner` を使用します。タイムゾーンを省略した場合、Gateway ホストのローカルタイムゾーンが使用されます。

多数のゲートウェイでのトップオブアワー負荷スパイクを軽減するため、OpenClaw は繰り返しトップオブアワー式（例: `0 * * * *`、`0 */2 * * *`）に対して最大5分の決定論的なジョブごとのずらしウィンドウを適用します。`0 7 * * *` のような固定時間の式は正確なままです。

任意の cron スケジュールに対して、`schedule.staggerMs` で明示的なずらしウィンドウを設定できます（`0` で正確なタイミングを維持）。CLI ショートカット:

- `--stagger 30s`（または `1m`、`5m`）で明示的なずらしウィンドウを設定。
- `--exact` で `staggerMs = 0` を強制。

### メインセッション vs アイソレーテッド実行

#### メインセッションジョブ（システムイベント）

メインジョブはシステムイベントをキューに追加し、オプションでハートビートランナーを起動します。`payload.kind = "systemEvent"` を使用する必要があります。

- `wakeMode: "now"`（デフォルト）: イベントが即時ハートビート実行をトリガーします。
- `wakeMode: "next-heartbeat"`: イベントは次のスケジュールされたハートビートを待ちます。

通常のハートビートプロンプト + メインセッションコンテキストが必要な場合に最適です。[ハートビート](/gateway/heartbeat) を参照してください。

#### アイソレーテッドジョブ（専用 cron セッション）

アイソレーテッドジョブはセッション `cron:<jobId>` で専用のエージェントターンを実行します。

主な動作:

- プロンプトはトレーサビリティのために `[cron:<jobId> <job name>]` でプレフィックスされます。
- 各実行は**新しいセッション ID** で開始されます（以前の会話は引き継がれません）。
- デフォルト動作: `delivery` を省略した場合、アイソレーテッドジョブはサマリーをアナウンスします（`delivery.mode = "announce"`）。
- `delivery.mode` で動作を選択します:
  - `announce`: ターゲットチャンネルにサマリーを配信し、メインセッションに短いサマリーを投稿します。
  - `webhook`: 完了イベントのペイロードを `delivery.to` に POST します（完了イベントにサマリーが含まれる場合）。
  - `none`: 内部のみ（デリバリーなし、メインセッションサマリーなし）。
- `wakeMode` はメインセッションサマリーの投稿タイミングを制御します:
  - `now`: 即時ハートビート。
  - `next-heartbeat`: 次のスケジュールされたハートビートを待ちます。

メインチャット履歴を汚染すべきでない、ノイジーで頻繁な、または「バックグラウンドタスク」にはアイソレーテッドジョブを使用してください。

### ペイロード形状（何を実行するか）

2 つのペイロード種別がサポートされています:

- `systemEvent`: メインセッションのみ。ハートビートプロンプトを通じてルーティングされます。
- `agentTurn`: アイソレーテッドセッションのみ。専用のエージェントターンを実行します。

一般的な `agentTurn` フィールド:

- `message`: 必須のテキストプロンプト。
- `model` / `thinking`: オプションのオーバーライド（下記参照）。
- `timeoutSeconds`: オプションのタイムアウトオーバーライド。

デリバリー設定:

- `delivery.mode`: `none` | `announce` | `webhook`。
- `delivery.channel`: `last` または特定のチャンネル。
- `delivery.to`: チャンネル固有のターゲット（アナウンス）または Webhook URL（Webhook モード）。
- `delivery.bestEffort`: アナウンスデリバリーが失敗してもジョブを失敗させません。

アナウンスデリバリーは実行中のメッセージングツール送信を抑制します。代わりに `delivery.channel`/`delivery.to` を使用してチャットをターゲットにしてください。`delivery.mode = "none"` の場合、メインセッションにサマリーは投稿されません。

アイソレーテッドジョブで `delivery` を省略した場合、OpenClaw はデフォルトで `announce` を使用します。

#### アナウンスデリバリーフロー

`delivery.mode = "announce"` の場合、cron はアウトバウンドチャンネルアダプターを通じて直接デリバリーします。メインエージェントはメッセージの作成や転送のために起動されません。

動作の詳細:

- コンテンツ: デリバリーはアイソレーテッド実行のアウトバウンドペイロード（テキスト/メディア）を通常のチャンクとチャンネルフォーマットで使用します。
- ハートビートのみのレスポンス（実際のコンテンツのない `HEARTBEAT_OK`）はデリバリーされません。
- アイソレーテッド実行がメッセージツールを通じて同じターゲットにすでにメッセージを送信した場合、重複を避けるためにデリバリーはスキップされます。
- 不足または無効なデリバリーターゲットは `delivery.bestEffort = true` でない限りジョブを失敗させます。
- 短いサマリーは `delivery.mode = "announce"` の場合のみメインセッションに投稿されます。
- メインセッションサマリーは `wakeMode` を尊重します: `now` は即時ハートビートをトリガーし、`next-heartbeat` は次のスケジュールされたハートビートを待ちます。

#### Webhook デリバリーフロー

`delivery.mode = "webhook"` の場合、cron は完了イベントペイロードを `delivery.to` に POST します（完了イベントにサマリーが含まれる場合）。

動作の詳細:

- エンドポイントは有効な HTTP(S) URL である必要があります。
- Webhook モードではチャンネルデリバリーは試みられません。
- Webhook モードではメインセッションサマリーは投稿されません。
- `cron.webhookToken` が設定されている場合、認証ヘッダーは `Authorization: Bearer <cron.webhookToken>` です。
- 非推奨のフォールバック: `notify: true` が設定された保存済みの旧ジョブは `cron.webhook`（設定されている場合）に引き続き投稿し、警告が表示されます。`delivery.mode = "webhook"` に移行してください。

### モデルとシンキングのオーバーライド

アイソレーテッドジョブ（`agentTurn`）はモデルとシンキングレベルをオーバーライドできます:

- `model`: プロバイダー/モデル文字列（例: `anthropic/claude-sonnet-4-20250514`）またはエイリアス（例: `opus`）
- `thinking`: シンキングレベル（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`; GPT-5.2 + Codex モデルのみ）

注意: メインセッションジョブにも `model` を設定できますが、共有されるメインセッションモデルが変更されます。予期しないコンテキストのずれを避けるため、モデルのオーバーライドはアイソレーテッドジョブのみで使用することを推奨します。

解決の優先順位:

1. ジョブペイロードオーバーライド（最高優先度）
2. フック固有のデフォルト（例: `hooks.gmail.model`）
3. エージェント設定のデフォルト

### デリバリー（チャンネル + ターゲット）

アイソレーテッドジョブはトップレベルの `delivery` 設定を通じて出力をチャンネルに配信できます:

- `delivery.mode`: `announce`（チャンネルデリバリー）、`webhook`（HTTP POST）、または `none`。
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost`（プラグイン）/ `signal` / `imessage` / `last`。
- `delivery.to`: チャンネル固有の受信者ターゲット。

`announce` デリバリーはアイソレーテッドジョブ（`sessionTarget: "isolated"`）でのみ有効です。`webhook` デリバリーはメインジョブとアイソレーテッドジョブの両方で有効です。

`delivery.channel` または `delivery.to` を省略した場合、cron はメインセッションの「最後のルート」（エージェントが最後に返信した場所）にフォールバックします。

ターゲット形式のリマインダー:

- Slack/Discord/Mattermost（プラグイン）のターゲットは曖昧さを避けるために明示的なプレフィックス（例: `channel:<id>`、`user:<id>`）を使用してください。
- Telegram のトピックは `:topic:` 形式を使用してください（下記参照）。

#### Telegram デリバリーターゲット（トピック / フォームスレッド）

Telegram は `message_thread_id` を通じてフォームトピックをサポートしています。cron デリバリーでは、トピック/スレッドを `to` フィールドにエンコードできます:

- `-1001234567890`（チャット ID のみ）
- `-1001234567890:topic:123`（推奨: 明示的なトピックマーカー）
- `-1001234567890:123`（省略形: 数値サフィックス）

`telegram:...` / `telegram:group:...` のようなプレフィックス付きターゲットも受け入れられます:

- `telegram:group:-1001234567890:topic:123`

## ツールコール用 JSON スキーマ

Gateway の `cron.*` ツールを直接呼び出す場合（エージェントツールコールまたは RPC）にこれらの形状を使用してください。CLI フラグは `20m` のような人間が読みやすい形式を受け入れますが、ツールコールでは `schedule.at` に ISO 8601 文字列、`schedule.everyMs` にミリ秒を使用してください。

### cron.add パラメータ

ワンショット、メインセッションジョブ（システムイベント）:

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

繰り返し、デリバリー付きアイソレーテッドジョブ:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

注意:

- `schedule.kind`: `at`（`at`）、`every`（`everyMs`）、または `cron`（`expr`、オプションの `tz`）。
- `schedule.at` は ISO 8601 を受け入れます（タイムゾーンはオプション。省略時は UTC として扱われます）。
- `everyMs` はミリ秒です。
- `sessionTarget` は `"main"` または `"isolated"` で、`payload.kind` と一致する必要があります。
- オプションフィールド: `agentId`、`description`、`enabled`、`deleteAfterRun`（`at` のデフォルトは true）、`delivery`。
- `wakeMode` を省略した場合のデフォルトは `"now"` です。

### cron.update パラメータ

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

注意:

- `jobId` が正規形式です。互換性のために `id` も受け入れられます。
- パッチで `agentId: null` を使用してエージェントバインディングをクリアします。

### cron.run および cron.remove パラメータ

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## ストレージと履歴

- ジョブストア: `~/.openclaw/cron/jobs.json`（Gateway 管理の JSON）。
- 実行履歴: `~/.openclaw/cron/runs/<jobId>.jsonl`（JSONL、サイズと行数で自動削除）。
- `sessions.json` のアイソレーテッド cron 実行セッションは `cron.sessionRetention`（デフォルト `24h`; 無効にするには `false` を設定）でプルーニングされます。
- ストアパスのオーバーライド: 設定の `cron.store`。

## 設定

```json5
{
  cron: {
    enabled: true, // デフォルト true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // デフォルト 1
    webhook: "https://example.invalid/legacy", // notify:true のジョブの非推奨フォールバック
    webhookToken: "replace-with-dedicated-webhook-token", // Webhook モード用のオプションの Bearer トークン
    sessionRetention: "24h", // 期間文字列または false
    runLog: {
      maxBytes: "2mb", // デフォルト 2_000_000 バイト
      keepLines: 2000, // デフォルト 2000
    },
  },
}
```

実行ログのプルーニング動作:

- `cron.runLog.maxBytes`: プルーニング前の最大実行ログファイルサイズ。
- `cron.runLog.keepLines`: プルーニング時に最新の N 行のみ保持します。
- 両方とも `cron/runs/<jobId>.jsonl` ファイルに適用されます。

Webhook の動作:

- 推奨: ジョブごとに `delivery.mode: "webhook"` と `delivery.to: "https://..."` を設定します。
- Webhook URL は有効な `http://` または `https://` URL である必要があります。
- 投稿時のペイロードは cron 完了イベントの JSON です。
- `cron.webhookToken` が設定されている場合、認証ヘッダーは `Authorization: Bearer <cron.webhookToken>` です。
- `cron.webhookToken` が設定されていない場合、`Authorization` ヘッダーは送信されません。
- 非推奨のフォールバック: `notify: true` が設定された保存済みの旧ジョブは存在する場合 `cron.webhook` を引き続き使用します。

Cron を完全に無効にする:

- `cron.enabled: false`（設定）
- `OPENCLAW_SKIP_CRON=1`（環境変数）

## メンテナンス

Cron には2つの組み込みメンテナンスパスがあります: アイソレーテッド実行セッションの保持と実行ログのプルーニングです。

### デフォルト

- `cron.sessionRetention`: `24h`（実行セッションのプルーニングを無効にするには `false` を設定）
- `cron.runLog.maxBytes`: `2_000_000` バイト
- `cron.runLog.keepLines`: `2000`

### 動作の仕組み

- アイソレーテッド実行はセッションエントリ（`...:cron:<jobId>:run:<uuid>`）とトランスクリプトファイルを作成します。
- リーパーは `cron.sessionRetention` より古い期限切れの実行セッションエントリを削除します。
- 削除された実行セッションがセッションストアから参照されなくなった場合、OpenClaw はトランスクリプトファイルをアーカイブし、同じ保持ウィンドウで古い削除済みアーカイブを削除します。
- 各実行後、`cron/runs/<jobId>.jsonl` のサイズがチェックされます:
  - ファイルサイズが `runLog.maxBytes` を超えた場合、最新の `runLog.keepLines` 行にトリミングされます。

### 高ボリュームスケジューラーのパフォーマンス上の注意

高頻度の cron 設定は大きな実行セッションと実行ログのフットプリントを生成する可能性があります。メンテナンスは組み込まれていますが、緩い制限は不必要な IO とクリーンアップ作業を引き起こす可能性があります。

注意点:

- 多くのアイソレーテッド実行を伴う長い `cron.sessionRetention` ウィンドウ
- 大きな `runLog.maxBytes` と組み合わせた高い `cron.runLog.keepLines`
- 同じ `cron/runs/<jobId>.jsonl` に書き込む多くのノイジーな繰り返しジョブ

対処方法:

- `cron.sessionRetention` をデバッグ/監査のニーズに応じてできるだけ短く保つ
- 適度な `runLog.maxBytes` と `runLog.keepLines` で実行ログを制限する
- ノイジーなバックグラウンドジョブをアイソレーテッドモードに移動し、不要なチャットを避けるデリバリールールを設定する
- `openclaw cron runs` で定期的に成長を確認し、ログが大きくなる前に保持を調整する

### カスタマイズ例

実行セッションを1週間保持し、大きな実行ログを許可する:

```json5
{
  cron: {
    sessionRetention: "7d",
    runLog: {
      maxBytes: "10mb",
      keepLines: 5000,
    },
  },
}
```

アイソレーテッド実行セッションのプルーニングを無効にし、実行ログのプルーニングを維持する:

```json5
{
  cron: {
    sessionRetention: false,
    runLog: {
      maxBytes: "5mb",
      keepLines: 3000,
    },
  },
}
```

高ボリューム cron 使用向けのチューニング（例）:

```json5
{
  cron: {
    sessionRetention: "12h",
    runLog: {
      maxBytes: "3mb",
      keepLines: 1500,
    },
  },
}
```

## CLI クイックスタート

ワンショットリマインダー（UTC ISO、成功後に自動削除）:

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

ワンショットリマインダー（メインセッション、即時ウェイク）:

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

繰り返しアイソレーテッドジョブ（WhatsApp にアナウンス）:

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

明示的な 30 秒ずらしを使用した繰り返し Cronジョブ:

```bash
openclaw cron add \
  --name "Minute watcher" \
  --cron "0 * * * * *" \
  --tz "UTC" \
  --stagger 30s \
  --session isolated \
  --message "Run minute watcher checks." \
  --announce
```

繰り返しアイソレーテッドジョブ（Telegram トピックへのデリバリー）:

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

モデルとシンキングオーバーライド付きアイソレーテッドジョブ:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

エージェント選択（マルチエージェント設定）:

```bash
# ジョブをエージェント "ops" にピン留め（そのエージェントがない場合はデフォルトにフォールバック）
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 既存のジョブのエージェントを切り替えまたはクリア
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手動実行（デフォルトは強制実行。期限が来たときだけ実行する場合は `--due` を使用）:

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

既存のジョブを編集（フィールドのパッチ）:

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

既存の Cronジョブをスケジュール通りに正確に実行する（ずらしなし）:

```bash
openclaw cron edit <jobId> --exact
```

実行履歴:

```bash
openclaw cron runs --id <jobId> --limit 50
```

ジョブを作成せずに即時システムイベント:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API サーフェス

- `cron.list`、`cron.status`、`cron.add`、`cron.update`、`cron.remove`
- `cron.run`（強制または期限付き）、`cron.runs`
  ジョブなしの即時システムイベントには [`openclaw system event`](/cli/system) を使用してください。

## トラブルシューティング

### 「何も実行されない」

- cron が有効かチェック: `cron.enabled` と `OPENCLAW_SKIP_CRON`。
- Gateway が継続して動作しているか確認（cron は Gateway プロセス内で実行されます）。
- `cron` スケジュールの場合: タイムゾーン（`--tz`）とホストのタイムゾーンを確認してください。

### 繰り返しジョブが失敗後に遅延し続ける

- OpenClaw は連続エラー後に繰り返しジョブに指数バックオフリトライを適用します: 30秒、1分、5分、15分、その後リトライ間隔は60分。
- バックオフは次の成功した実行後に自動的にリセットされます。
- ワンショット（`at`）ジョブは終端実行（`ok`、`error`、または `skipped`）後に無効化され、リトライしません。

### Telegram が間違った場所に配信される

- フォームトピックには `-100…:topic:<id>` を使用して明示的かつ曖昧さがないようにしてください。
- ログや保存された「最後のルート」ターゲットに `telegram:...` プレフィックスが表示される場合、これは正常です。cron デリバリーはこれを受け入れ、トピック ID を正しくパースします。

### サブエージェントのアナウンスデリバリーのリトライ

- サブエージェントの実行が完了すると、Gateway はリクエスターセッションに結果をアナウンスします。
- アナウンスフローが `false` を返した場合（例: リクエスターセッションがビジー）、Gateway は `announceRetryCount` でのトラッキングで最大3回リトライします。
- `endedAt` から5分以上経過したアナウンスは強制期限切れとなり、古いエントリが無限にループするのを防ぎます。
- ログに繰り返しアナウンスデリバリーが表示される場合は、高い `announceRetryCount` 値を持つエントリのサブエージェントレジストリを確認してください。
