---
summary: "Gateway スケジューラーのCronジョブとウェイクアップ"
read_when:
  - バックグラウンドジョブやウェイクアップのスケジュール設定
  - ハートビートと連携した自動化の接続
  - スケジュールタスクにハートビートとCronのどちらを使うかの判断
title: "Cron ジョブ"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 9ce8154a641d86c916aada8cd77f79981452018e0e92708e9699a5e99016d226
    source_path: automation/cron-jobs.md
    workflow: 15
---

# Cron ジョブ（Gateway ゲートウェイスケジューラー）

> **Cron と Heartbeat の違い？** どちらを使うべきかについては [Cron vs Heartbeat](/automation/cron-vs-heartbeat) を参照してください。

Cron は Gateway ゲートウェイの内蔵スケジューラーです。ジョブを永続化し、適切なタイミングでエージェントを起動し、オプションで出力をチャットに配信できます。

すべての Cron 実行は[バックグラウンドタスク](/automation/tasks)レコードを作成します。主な違いは可視性です：

- `sessionTarget: "main"` は `silent` 通知ポリシーでタスクを作成します。メインセッションとハートビートフローにシステムイベントをスケジュールしますが、通知は生成しません。
- `sessionTarget: "isolated"` または `sessionTarget: "session:..."` は `openclaw tasks` に表示され、配信通知が届く可視タスクを作成します。

_「毎朝これを実行する」_ または _「20分後にエージェントを起動する」_ といった場合には Cron が適切なメカニズムです。

トラブルシューティング: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron は **Gateway ゲートウェイ内部**で実行されます（モデル内部ではありません）。
- ジョブは `~/.openclaw/cron/` に永続化されるため、再起動してもスケジュールが失われません。
- 2つの実行スタイル：
  - **メインセッション**: システムイベントをキューに入れ、次のハートビートで実行。
  - **分離モード**: `cron:<jobId>` またはカスタムセッションで専用エージェントターンを実行し、配信あり（デフォルトはアナウンス、またはなし）。
  - **現在のセッション**: Cron 作成時のセッションにバインド（`sessionTarget: "current"`）。
  - **カスタムセッション**: 永続的な名前付きセッションで実行（`sessionTarget: "session:custom-id"`）。
- ウェイクアップはファーストクラス：ジョブは「今すぐ起動」か「次のハートビートで」を指定できます。
- Webhook 投稿はジョブごとに `delivery.mode = "webhook"` + `delivery.to = "<url>"` で設定。
- `notify: true` で保存されたジョブと `cron.webhook` が設定されている場合のレガシーフォールバックは引き続き動作します。これらのジョブを Webhook 配信モードに移行してください。
- アップグレードには `openclaw doctor --fix` で古い `threadId` などのトップレベル配信ヒントを含むレガシー Cron ストアフィールドを正規化できます。

## クイックスタート（実用的）

一回限りのリマインダーを作成し、存在を確認し、すぐに実行する：

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

配信付きの繰り返し分離ジョブをスケジュール：

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

## ツールコール同等物（Gateway ゲートウェイ Cron ツール）

正規の JSON シェイプと例については、[ツールコールの JSON スキーマ](/automation/cron-jobs#json-schema-for-tool-calls) を参照してください。

## Cron ジョブの保存場所

Cron ジョブは Gateway ゲートウェイホストの `~/.openclaw/cron/jobs.json` にデフォルトで永続化されます。
Gateway ゲートウェイはファイルをメモリに読み込み、変更時に書き戻します。そのため、手動編集は Gateway ゲートウェイが停止しているときのみ安全です。変更には `openclaw cron add/edit` または Cron ツールコール API を使用してください。

## 初心者向けの概要

Cron ジョブとは：**いつ**実行するか + **何を**するか、と考えてください。

1. **スケジュールを選ぶ**
   - 一回限りのリマインダー → `schedule.kind = "at"`（CLI: `--at`）
   - 繰り返しジョブ → `schedule.kind = "every"` または `schedule.kind = "cron"`
   - タイムゾーンを省略した ISO タイムスタンプは **UTC** として扱われます。

2. **実行場所を選ぶ**
   - `sessionTarget: "main"` → メインコンテキストで次のハートビート中に実行。
   - `sessionTarget: "isolated"` → `cron:<jobId>` で専用エージェントターンを実行。
   - `sessionTarget: "current"` → 現在のセッションにバインド（作成時に `session:<sessionKey>` に解決）。
   - `sessionTarget: "session:custom-id"` → 実行間でコンテキストを維持する永続的な名前付きセッションで実行。

   デフォルト動作（変更なし）：
   - `systemEvent` ペイロードは `main` にデフォルト
   - `agentTurn` ペイロードは `isolated` にデフォルト

   現在のセッションバインドを使用するには、明示的に `sessionTarget: "current"` を設定してください。

3. **ペイロードを選ぶ**
   - メインセッション → `payload.kind = "systemEvent"`
   - 分離セッション → `payload.kind = "agentTurn"`

オプション：一回限りのジョブ（`schedule.kind = "at"`）はデフォルトで成功後に削除されます。保持するには `deleteAfterRun: false` を設定してください（成功後に無効になります）。

## 概念

### ジョブ

Cron ジョブは以下を含む保存されたレコードです：

- **スケジュール**（いつ実行するか）
- **ペイロード**（何をするか）
- オプションの**配信モード**（`announce`、`webhook`、または `none`）
- オプションの**エージェントバインディング**（`agentId`）：特定のエージェントでジョブを実行します。不明な場合はデフォルトエージェントにフォールバックします。

ジョブは安定した `jobId`（CLI/Gateway ゲートウェイ API で使用）で識別されます。
エージェントツールコールでは `jobId` が正規です。後方互換性のためにレガシー `id` も受け入れます。
一回限りのジョブはデフォルトで成功後に自動削除されます。保持するには `deleteAfterRun: false` を設定してください。

### スケジュール

Cron は3種類のスケジュールをサポートします：

- `at`: `schedule.at`（ISO 8601）による一回限りのタイムスタンプ。
- `every`: 固定間隔（ミリ秒）。
- `cron`: 5フィールドの Cron 式（または秒付きの6フィールド）とオプションの IANA タイムゾーン。

Cron 式は `croner` を使用します。タイムゾーンを省略すると、Gateway ゲートウェイホストのローカルタイムゾーンが使用されます。

多くの Gateway ゲートウェイにまたがるトップオブアワーの負荷スパイクを減らすため、OpenClaw は繰り返しトップオブアワー式（例：`0 * * * *`、`0 */2 * * *`）に対して最大5分の決定論的なジョブごとのスタガーウィンドウを適用します。`0 7 * * *` などの固定時間式は正確なままです。

任意の Cron スケジュールに対して、`schedule.staggerMs` で明示的なスタガーウィンドウを設定できます（`0` は正確なタイミングを維持）。CLI ショートカット：

- `--stagger 30s`（または `1m`、`5m`）で明示的なスタガーウィンドウを設定。
- `--exact` で `staggerMs = 0` を強制。

### メインと分離の実行

#### メインセッションジョブ（システムイベント）

メインジョブはシステムイベントをキューに入れ、オプションでハートビートランナーを起動します。
`payload.kind = "systemEvent"` を使用する必要があります。

- `wakeMode: "now"`（デフォルト）：イベントが即座にハートビート実行をトリガーします。
- `wakeMode: "next-heartbeat"`：イベントは次のスケジュールされたハートビートを待ちます。

通常のハートビートプロンプト + メインセッションコンテキストが必要な場合に最適です。
[Heartbeat](/gateway/heartbeat) を参照してください。

メインセッション Cron ジョブは `silent` 通知ポリシーで[バックグラウンドタスク](/automation/tasks)レコードを作成します（デフォルトで通知なし）。`openclaw tasks list` に表示されますが、配信メッセージは生成されません。

#### 分離ジョブ（専用 Cron セッション）

分離ジョブは `cron:<jobId>` またはカスタムセッションで専用エージェントターンを実行します。

主な動作：

- プロンプトはトレーサビリティのために `[cron:<jobId> <job name>]` でプレフィックスされます。
- 各実行は**新しいセッション ID** で開始されます（カスタムセッションを使用しない限り、以前の会話は引き継がれません）。
- カスタムセッション（`session:xxx`）は実行間でコンテキストを維持し、以前のサマリーを基にした毎日のスタンドアップなどのワークフローを可能にします。
- デフォルト動作：`delivery` が省略された場合、分離ジョブはサマリーをアナウンスします（`delivery.mode = "announce"`）。
- `delivery.mode` で何が起きるかを選択：
  - `announce`：ターゲットチャンネルにサマリーを配信し、メインセッションに簡単なサマリーを投稿。
  - `webhook`：完了イベントにサマリーが含まれる場合、`delivery.to` に完了イベントペイロードをPOST。
  - `none`：内部のみ（配信なし、メインセッションサマリーなし）。
- `wakeMode` はメインセッションサマリーがいつ投稿されるかを制御：
  - `now`：即座のハートビート。
  - `next-heartbeat`：次のスケジュールされたハートビートを待つ。

メインのチャット履歴をスパムしたくないノイズの多い、頻繁な、または「バックグラウンドタスク」には分離ジョブを使用してください。

これらのデタッチされた実行は `openclaw tasks` で表示可能な[バックグラウンドタスク](/automation/tasks)レコードを作成し、タスクの監査とメンテナンスの対象となります。

### ペイロードシェイプ（何が実行されるか）

2種類のペイロードがサポートされています：

- `systemEvent`：メインセッション専用、ハートビートプロンプトを通じてルーティング。
- `agentTurn`：分離セッション専用、専用エージェントターンを実行。

一般的な `agentTurn` フィールド：

- `message`：必須テキストプロンプト。
- `model` / `thinking`：オプションのオーバーライド（以下参照）。
- `timeoutSeconds`：オプションのタイムアウトオーバーライド。
- `lightContext`：ワークスペースブートストラップファイルインジェクションが不要なジョブ向けのオプションの軽量ブートストラップモード。
- `toolsAllow`：ジョブが使用できるツールを制限するオプションのツール名配列（例：`["exec", "read", "write"]`）。

配信設定：

- `delivery.mode`：`none` | `announce` | `webhook`。
- `delivery.channel`：`last` または特定のチャンネル。
- `delivery.to`：チャンネル固有のターゲット（アナウンス）または Webhook URL（Webhook モード）。
- `delivery.threadId`：ターゲットチャンネルがスレッド配信をサポートする場合のオプションの明示的なスレッドまたはトピック ID。
- `delivery.bestEffort`：アナウンス配信が失敗してもジョブが失敗しないようにする。

アナウンス配信は実行中のメッセージングツール送信を抑制します。チャットをターゲットにするには `delivery.channel`/`delivery.to` を使用してください。`delivery.mode = "none"` の場合、メインセッションにサマリーは投稿されません。

分離ジョブで `delivery` が省略された場合、OpenClaw はデフォルトで `announce` になります。

#### アナウンス配信フロー

`delivery.mode = "announce"` の場合、Cron はアウトバウンドチャンネルアダプターを介して直接配信します。
メインエージェントはメッセージの作成や転送のために起動されません。

動作の詳細：

- コンテンツ：配信は分離実行のアウトバウンドペイロード（テキスト/メディア）を通常のチャンキングとチャンネルフォーマットで使用します。
- ハートビートのみの応答（実際のコンテンツのない `HEARTBEAT_OK`）は配信されません。
- 分離実行がメッセージツールを介して同じターゲットにすでにメッセージを送信していた場合、重複を避けるために配信はスキップされます。
- 見つからないか無効な配信ターゲットは `delivery.bestEffort = true` でない限りジョブを失敗させます。
- `delivery.mode = "announce"` の場合のみ、メインセッションに短いサマリーが投稿されます。
- メインセッションサマリーは `wakeMode` を尊重します：`now` は即座のハートビートをトリガーし、`next-heartbeat` は次のスケジュールされたハートビートを待ちます。

#### Webhook 配信フロー

`delivery.mode = "webhook"` の場合、完了イベントにサマリーが含まれると Cron は `delivery.to` に完了イベントペイロードをPOSTします。

動作の詳細：

- エンドポイントは有効な HTTP(S) URL である必要があります。
- Webhook モードではチャンネル配信は試みられません。
- Webhook モードではメインセッションサマリーは投稿されません。
- `cron.webhookToken` が設定されている場合、認証ヘッダーは `Authorization: Bearer <cron.webhookToken>` です。
- 非推奨のフォールバック：`notify: true` の保存されたレガシージョブは警告付きで `cron.webhook`（設定されている場合）に引き続きPOSTします。`delivery.mode = "webhook"` に移行してください。

### モデルと思考のオーバーライド

分離ジョブ（`agentTurn`）はモデルと思考レベルをオーバーライドできます：

- `model`：プロバイダー/モデル文字列（例：`anthropic/claude-sonnet-4-20250514`）またはエイリアス（例：`opus`）
- `thinking`：思考レベル（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`；GPT-5.2 + Codex モデルのみ）

注意：メインセッションジョブにも `model` を設定できますが、共有メインセッションモデルが変更されます。予期しないコンテキストの変化を避けるため、モデルのオーバーライドは分離ジョブのみに推奨します。

解決優先度：

1. ジョブペイロードオーバーライド（最高）
2. フック固有のデフォルト（例：`hooks.gmail.model`）
3. エージェント設定のデフォルト

### 軽量ブートストラップコンテキスト

分離ジョブ（`agentTurn`）は `lightContext: true` を設定して軽量ブートストラップコンテキストで実行できます。

- ワークスペースブートストラップファイルインジェクションが不要なスケジュールされたタスクに使用します。
- 実際には、組み込みランタイムは `bootstrapContextMode: "lightweight"` で実行され、Cron ブートストラップコンテキストを意図的に空に保ちます。
- CLI 同等物：`openclaw cron add --light-context ...` および `openclaw cron edit --light-context`。

### 配信（チャンネル + ターゲット）

分離ジョブはトップレベルの `delivery` 設定を介してチャンネルに出力を配信できます：

- `delivery.mode`：`announce`（チャンネル配信）、`webhook`（HTTP POST）、または `none`。
- `delivery.channel`：`last` または任意の配信可能なチャンネル ID（例：`discord`、`matrix`、`telegram`、`whatsapp`）。
- `delivery.to`：チャンネル固有の受信者ターゲット。
- `delivery.threadId`：Telegram、Slack、Discord、または Matrix のような特定のスレッドを `delivery.to` にエンコードせずに指定したい場合のオプションのスレッド/トピックオーバーライド。

`announce` 配信は分離ジョブ（`sessionTarget: "isolated"`）にのみ有効です。
`webhook` 配信はメインと分離の両方のジョブに有効です。

`delivery.channel` または `delivery.to` が省略された場合、Cron はメインセッションの「ラストルート」（エージェントが最後に返答した場所）にフォールバックできます。

ターゲットフォーマットの注意：

- Slack/Discord/Mattermost（プラグイン）ターゲットは曖昧さを避けるために明示的なプレフィックスを使用してください（例：`channel:<id>`、`user:<id>`）。
  Mattermost の26文字のベア ID は**ユーザー優先**で解決されます（ユーザーが存在する場合は DM、それ以外はチャンネル）。決定論的なルーティングには `user:<id>` または `channel:<id>` を使用してください。
- Telegram トピックは `:topic:` 形式を使用してください（以下参照）。

#### Telegram 配信ターゲット（トピック/フォーラムスレッド）

Telegram は `message_thread_id` を介したフォーラムトピックをサポートします。Cron 配信では、`to` フィールドにトピック/スレッドをエンコードできます：

- `-1001234567890`（チャット ID のみ）
- `-1001234567890:topic:123`（推奨：明示的なトピックマーカー）
- `-1001234567890:123`（省略形：数値サフィックス）

`telegram:...` / `telegram:group:...` のようなプレフィックス付きターゲットも受け入れられます：

- `telegram:group:-1001234567890:topic:123`

## ツールコールの JSON スキーマ

Gateway ゲートウェイの `cron.*` ツールを直接呼び出す場合（エージェントツールコールまたは RPC）にこれらのシェイプを使用します。
CLI フラグは `20m` のような人間向けの時間を受け入れますが、ツールコールでは `schedule.at` には ISO 8601 文字列、`schedule.everyMs` にはミリ秒を使用してください。

### cron.add パラメーター

一回限りのメインセッションジョブ（システムイベント）：

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

配信付きの繰り返し分離ジョブ：

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates.",
    "lightContext": true
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

現在のセッションにバインドされた繰り返しジョブ（作成時に自動解決）：

```json
{
  "name": "Daily standup",
  "schedule": { "kind": "cron", "expr": "0 9 * * *" },
  "sessionTarget": "current",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize yesterday's progress."
  }
}
```

カスタム永続セッションでの繰り返しジョブ：

```json
{
  "name": "Project monitor",
  "schedule": { "kind": "every", "everyMs": 300000 },
  "sessionTarget": "session:project-alpha-monitor",
  "payload": {
    "kind": "agentTurn",
    "message": "Check project status and update the running log."
  }
}
```

注意：

- `schedule.kind`：`at`（`at`）、`every`（`everyMs`）、または `cron`（`expr`、オプションの `tz`）。
- `schedule.at` は ISO 8601 を受け入れます。タイムゾーンなしのツール/API 値は UTC として扱われます。CLI はローカルウォールクロックの一回限りのジョブ用に `openclaw cron add|edit --at "<offset-less-iso>" --tz <iana>` も受け入れます。
- `everyMs` はミリ秒です。
- `sessionTarget`：`"main"`、`"isolated"`、`"current"`、または `"session:<custom-id>"`。
- `"current"` は作成時に `"session:<sessionKey>"` に解決されます。
- カスタムセッション（`session:xxx`）は実行間で永続的なコンテキストを維持します。
- オプションフィールド：`agentId`、`description`、`enabled`、`deleteAfterRun`（`at` のデフォルトは true）、`delivery`、`toolsAllow`。
- `toolsAllow`：ジョブが使用できるツールを制限するオプションのツール名配列（例：`["exec", "read"]`）。すべてのツールを使用するには省略するか `null` を設定。
- `wakeMode` は省略時に `"now"` にデフォルト。

### cron.update パラメーター

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

注意：

- `jobId` が正規です。互換性のために `id` も受け入れます。
- エージェントバインディングをクリアするにはパッチで `agentId: null` を使用。

### cron.run と cron.remove パラメーター

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## ストレージと履歴

- ジョブストア：`~/.openclaw/cron/jobs.json`（Gateway ゲートウェイ管理の JSON）。
- 実行履歴：`~/.openclaw/cron/runs/<jobId>.jsonl`（JSONL、サイズと行数で自動プルーニング）。
- `sessions.json` の分離 Cron 実行セッションは `cron.sessionRetention`（デフォルト `24h`；無効にするには `false`）でプルーニング。
- ストアパスのオーバーライド：設定の `cron.store`。

## リトライポリシー

ジョブが失敗した場合、OpenClaw はエラーを**一時的**（リトライ可能）または**永続的**（即座に無効化）に分類します。

### 一時的なエラー（リトライ）

- レートリミット（429、リクエスト過多、リソース枯渇）
- プロバイダーの過負荷（例：Anthropic `529 overloaded_error`、過負荷フォールバックサマリー）
- ネットワークエラー（タイムアウト、ECONNRESET、フェッチ失敗、ソケット）
- サーバーエラー（5xx）
- Cloudflare 関連エラー

### 永続的なエラー（リトライなし）

- 認証失敗（無効な API キー、未認証）
- 設定または検証エラー
- その他の非一時的エラー

### デフォルト動作（設定なし）

**一回限りのジョブ（`schedule.kind: "at"`）：**

- 一時的なエラー時：指数バックオフ（30s → 1m → 5m）で最大3回リトライ。
- 永続的なエラー時：即座に無効化。
- 成功またはスキップ時：無効化（`deleteAfterRun: true` の場合は削除）。

**繰り返しジョブ（`cron` / `every`）：**

- エラー時：次のスケジュールされた実行の前に指数バックオフ（30s → 1m → 5m → 15m → 60m）を適用。
- ジョブは有効のまま；次の成功した実行後にバックオフがリセット。

これらのデフォルトをオーバーライドするには `cron.retry` を設定してください（[設定](/automation/cron-jobs#configuration) を参照）。

## 設定

```json5
{
  cron: {
    enabled: true, // デフォルト true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // デフォルト 1
    // オプション：一回限りのジョブのリトライポリシーをオーバーライド
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "server_error"],
    },
    webhook: "https://example.invalid/legacy", // notify:true ジョブの非推奨フォールバック
    webhookToken: "replace-with-dedicated-webhook-token", // Webhook モードのオプションのベアラートークン
    sessionRetention: "24h", // 時間文字列または false
    runLog: {
      maxBytes: "2mb", // デフォルト 2_000_000 バイト
      keepLines: 2000, // デフォルト 2000
    },
  },
}
```

実行ログのプルーニング動作：

- `cron.runLog.maxBytes`：プルーニング前の最大実行ログファイルサイズ。
- `cron.runLog.keepLines`：プルーニング時に最新の N 行のみを保持。
- どちらも `cron/runs/<jobId>.jsonl` ファイルに適用。

Webhook 動作：

- 推奨：ジョブごとに `delivery.mode: "webhook"` と `delivery.to: "https://..."` を設定。
- Webhook URL は有効な `http://` または `https://` URL である必要があります。
- 投稿時のペイロードは Cron 完了イベント JSON です。
- `cron.webhookToken` が設定されている場合、認証ヘッダーは `Authorization: Bearer <cron.webhookToken>`。
- `cron.webhookToken` が設定されていない場合、`Authorization` ヘッダーは送信されません。
- 非推奨フォールバック：`notify: true` の保存されたレガシージョブは存在する場合 `cron.webhook` を引き続き使用。

Cron を完全に無効にする：

- `cron.enabled: false`（設定）
- `OPENCLAW_SKIP_CRON=1`（環境変数）

## メンテナンス

Cron には2つの組み込みメンテナンスパスがあります：分離実行セッションの保持と実行ログのプルーニング。

### デフォルト

- `cron.sessionRetention`：`24h`（実行セッションのプルーニングを無効にするには `false`）
- `cron.runLog.maxBytes`：`2_000_000` バイト
- `cron.runLog.keepLines`：`2000`

### 仕組み

- 分離実行はセッションエントリ（`...:cron:<jobId>:run:<uuid>`）とトランスクリプトファイルを作成。
- リーパーは `cron.sessionRetention` より古い期限切れの実行セッションエントリを削除。
- セッションストアによって参照されなくなった削除済み実行セッションについて、OpenClaw はトランスクリプトファイルをアーカイブし、同じ保持ウィンドウで古い削除済みアーカイブをパージします。
- 各実行アペンド後、`cron/runs/<jobId>.jsonl` のサイズがチェックされます：
  - ファイルサイズが `runLog.maxBytes` を超えると、最新の `runLog.keepLines` 行に切り詰められます。

### 高ボリュームスケジューラーのパフォーマンスの注意

高頻度の Cron セットアップは大きな実行セッションと実行ログのフットプリントを生成する可能性があります。メンテナンスは組み込まれていますが、緩い制限によって不必要な IO とクリーンアップ作業が発生することがあります。

注意すべき点：

- 多くの分離実行を伴う長い `cron.sessionRetention` ウィンドウ
- 大きな `runLog.maxBytes` と組み合わさった高い `cron.runLog.keepLines`
- 同じ `cron/runs/<jobId>.jsonl` に書き込む多くのノイズの多い繰り返しジョブ

対処法：

- デバッグ/監査ニーズが許す限り `cron.sessionRetention` を短く保つ
- 適度な `runLog.maxBytes` と `runLog.keepLines` で実行ログを制限する
- ノイズの多いバックグラウンドジョブを不必要なチャットを避ける配信ルールを持つ分離モードに移行する
- `openclaw cron runs` で定期的に成長を確認し、ログが大きくなる前に保持を調整する

### カスタマイズ例

実行セッションを1週間保持してより大きな実行ログを許可：

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

分離実行セッションのプルーニングを無効にして実行ログのプルーニングを維持：

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

高ボリュームの Cron 使用向けのチューニング（例）：

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

一回限りのリマインダー（UTC ISO、成功後に自動削除）：

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

一回限りのリマインダー（メインセッション、即座に起動）：

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

繰り返し分離ジョブ（WhatsApp にアナウンス）：

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

明示的な30秒スタガーを持つ繰り返し Cron ジョブ：

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

繰り返し分離ジョブ（Telegram トピックに配信）：

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

モデルと思考のオーバーライド付き分離ジョブ：

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

エージェント選択（マルチエージェントセットアップ）：

```bash
# ジョブをエージェント "ops" に固定（そのエージェントが見つからない場合はデフォルトにフォールバック）
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 既存のジョブのエージェントを切り替えまたはクリア
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

ツール許可リスト（ジョブが使用できるツールを制限）：

```bash
# このジョブに exec と read ツールのみを許可
openclaw cron add --name "Scoped job" --cron "0 8 * * *" --session isolated --message "Run scoped checks" --tools exec,read

# 既存のジョブのツール許可リストを更新
openclaw cron edit <jobId> --tools exec,read,write

# ツール許可リストを削除（すべてのツールを使用）
openclaw cron edit <jobId> --clear-tools
```

手動実行（force がデフォルト、`--due` は期限が来たときのみ実行）：

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

`cron.run` はジョブが完了した後ではなく、手動実行がキューに入れられると確認します。成功したキュー応答は `{ ok: true, enqueued: true, runId }` のようになります。ジョブがすでに実行中か `--due` で期限が来たものが見つからない場合、応答は `{ ok: true, ran: false, reason }` のままです。最終的な完了エントリを確認するには `openclaw cron runs --id <jobId>` または `cron.runs` Gateway ゲートウェイメソッドを使用してください。

既存のジョブを編集（フィールドをパッチ）：

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

既存の Cron ジョブをスタガーなしでスケジュール通りに正確に実行：

```bash
openclaw cron edit <jobId> --exact
```

実行履歴：

```bash
openclaw cron runs --id <jobId> --limit 50
```

ジョブを作成せずに即座のシステムイベント：

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway ゲートウェイ API サーフェス

- `cron.list`、`cron.status`、`cron.add`、`cron.update`、`cron.remove`
- `cron.run`（force または due）、`cron.runs`
  ジョブなしの即座のシステムイベントには [`openclaw system event`](/cli/system) を使用してください。

## トラブルシューティング

### 「何も実行されない」

- Cron が有効かどうかを確認：`cron.enabled` と `OPENCLAW_SKIP_CRON`。
- Gateway ゲートウェイが継続的に実行されているか確認（Cron は Gateway ゲートウェイプロセス内で実行）。
- `cron` スケジュールの場合：タイムゾーン（`--tz`）とホストタイムゾーンを確認。

### 繰り返しジョブが失敗後に遅延し続ける

- OpenClaw は連続したエラーの後、繰り返しジョブに指数リトライバックオフを適用します：
  リトライ間隔は 30s、1m、5m、15m、そして 60m。
- バックオフは次の成功した実行後に自動的にリセットされます。
- 一回限り（`at`）ジョブは一時的なエラー（レートリミット、過負荷、ネットワーク、server_error）をバックオフで最大3回リトライします；永続的なエラーは即座に無効化されます。[リトライポリシー](/automation/cron-jobs#retry-policy) を参照。

### Telegram が間違った場所に配信する

- フォーラムトピックには `-100…:topic:<id>` を使用して明示的で曖昧さがないようにしてください。
- ログや保存された「ラストルート」ターゲットに `telegram:...` プレフィックスが見えても正常です；Cron 配信はそれらを受け入れ、トピック ID を正しく解析します。

### サブエージェントアナウンス配信のリトライ

- サブエージェント実行が完了すると、Gateway ゲートウェイはリクエスターセッションに結果をアナウンスします。
- アナウンスフローが `false` を返した場合（例：リクエスターセッションがビジー状態）、Gateway ゲートウェイは `announceRetryCount` でトラッキングしながら最大3回リトライします。
- `endedAt` から5分以上経過したアナウンスは、古いエントリが無限にループするのを防ぐために強制期限切れになります。
- ログに繰り返しのアナウンス配信が見られる場合、高い `announceRetryCount` 値を持つエントリのサブエージェントレジストリを確認してください。

## 関連

- [自動化の概要](/automation) — すべての自動化メカニズムの概要
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — どちらを使うか
- [バックグラウンドタスク](/automation/tasks) — Cron 実行のタスク台帳
- [Heartbeat](/gateway/heartbeat) — 定期的なメインセッションターン
- [トラブルシューティング](/automation/troubleshooting) — 自動化の問題のデバッグ
