---
summary: "Gateway スケジューラ向けの Cron ジョブとウェイクアップ"
read_when:
  - バックグラウンドジョブやウェイクアップのスケジューリングを行うとき
  - ハートビートと併用、または連動して実行すべき自動化を組み込むとき
  - スケジュールされたタスクで heartbeat と cron のどちらを使うか判断するとき
title: "Cron ジョブ"
---

# Cron ジョブ（Gateway スケジューラ）

> **Cron と Heartbeat の違いは？** それぞれの使い分けについては、[Cron vs Heartbeat](/automation/cron-vs-heartbeat) を参照してください。

Cron は Gateway に組み込まれたスケジューラです。ジョブを永続化し、適切なタイミングでエージェントを起動し、必要に応じて出力をチャットに配信できます。 ジョブを持続させ、
でエージェントを起動させ、必要に応じて出力をチャットに戻すことができます。

「**毎朝これを実行する**」や「**20 分後にエージェントを起こす**」といった用途には、cron が適しています。

トラブルシューティング: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron は **Gateway の内部で実行** されます（モデル内部ではありません）。
- ジョブは `~/.openclaw/cron/` の配下に永続化されるため、再起動してもスケジュールは失われません。
- 実行スタイルは 2 種類あります:
  - **メインセッション**: システムイベントをキューに入れ、次のハートビートで実行します。
  - **分離実行**: `cron:<jobId>` で専用のエージェントターンを実行し、配信（デフォルトは通知、またはなし）を行います。
- ウェイクアップは第一級の機能です。ジョブは「今すぐ起こす」か「次のハートビート」を指定できます。

## クイックスタート（実践）

単発のリマインダーを作成し、存在を確認して、すぐに実行します:

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

配信付きの分離実行の定期ジョブをスケジュールします:

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

## cron ジョブの保存場所

Cron ジョブは、デフォルトで Gateway ホスト上の `~/.openclaw/cron/jobs.json` に永続化されます。
Gateway はこのファイルをメモリに読み込み、変更時に書き戻します。そのため、手動編集は Gateway が停止している場合にのみ安全です。変更には `openclaw cron add/edit` または cron ツールコール API の使用を推奨します。
Gatewayはファイルをメモリにロードし、変更時に書き戻しますので、手動で編集する
はゲートウェイが停止した時のみ安全です。 変更を行うには、`opencraw cron add/edit` または cron
ツールコールの API を使用します。

## 初心者向け概要

cron ジョブは、**いつ** 実行するか + **何を** 実行するか、という考え方です。

1. **スケジュールを選ぶ**
   - 単発リマインダー → `schedule.kind = "at"`（CLI: `--at`）
   - 繰り返しジョブ → `schedule.kind = "every"` または `schedule.kind = "cron"`
   - ISO タイムスタンプにタイムゾーンが含まれない場合、**UTC** として扱われます。

2. **実行場所を選ぶ**
   - `sessionTarget: "main"` → 次のハートビートでメインコンテキストとして実行します。
   - `sessionTarget: "isolated"` → `cron:<jobId>` で専用のエージェントターンを実行します。

3. **ペイロードを選ぶ**
   - メインセッション → `payload.kind = "systemEvent"`
   - 分離セッション → `payload.kind = "agentTurn"`

任意: 単発ジョブ（`schedule.kind = "at"`）は、デフォルトで成功後に削除されます。保持したい場合は `deleteAfterRun: false` を設定してください（成功後は無効化されます）。
`deleteAfterRun: false` に設定するとそれらを保持します（成功後は無効になります）。

## 概念

### ジョブ

cron ジョブは、次の情報を持つ保存レコードです:

- **スケジュール**（いつ実行するか）
- **ペイロード**（何を実行するか）
- 任意の **配信モード**（通知またはなし）
- 任意の **エージェントバインディング**（`agentId`）: 特定のエージェントでジョブを実行します。指定がない、または不明な場合は、Gateway がデフォルトのエージェントにフォールバックします。

ジョブは安定した `jobId` (CLI/Gateway APIで使用されます) によって識別されます。
エージェントのツール呼び出しでは、 `jobId` は正規化されています。レガシーの `id` は互換性のため受け入れられます。
デフォルトで成功した後、ワンショットのジョブを自動的に削除します。`deleteAfterRun: false` を設定すると、削除できます。

### スケジュール

Cron は 3 種類のスケジュールをサポートします:

- `at`: `schedule.at`（ISO 8601）による単発タイムスタンプ
- `every`: 固定間隔（ミリ秒）
- `cron`: オプションの IANA タイムゾーン付き 5 フィールドの cron 式

cron 式は `croner` を使用します。タイムゾーンが省略された場合は、Gateway ホストのローカルタイムゾーンが使用されます。 If a timezone is omitted, the Gateway host’s
local timezone is used.

### メイン実行と分離実行

#### メインセッションジョブ（システムイベント）

主なジョブは、システムイベントをキューに入れ、必要に応じてハートビートランナーを起動します。
メインジョブはシステムイベントをキューに入れ、必要に応じてハートビートランナーを起動します。
`payload.kind = "systemEvent"` を使用する必要があります。

- `wakeMode: "now"`（デフォルト）: イベントは即座にハートビート実行をトリガーします。
- `wakeMode: "next-heartbeat"`: イベントは次に予定されたハートビートまで待機します。

通常のハートビートプロンプトとメインセッションのコンテキストを使いたい場合に最適です。
[Heartbeat](/gateway/heartbeat) を参照してください。
[Heartbeat](/gateway/heartbeat) を参照してください。

#### 分離ジョブ（専用 cron セッション）

分離ジョブは、セッション `cron:<jobId>` で専用のエージェントターンを実行します。

主な挙動:

- プロンプトはトレーサビリティのために `[cron:<jobId> <job name>]` が前置されます。
- 各実行は **新しいセッション ID** で開始されます（過去の会話は引き継がれません）。
- デフォルトの挙動: `delivery` が省略された場合、分離ジョブはサマリーを通知します（`delivery.mode = "announce"`）。
- `delivery.mode`（分離専用）で挙動を選択します:
  - `announce`: 対象チャンネルにサマリーを配信し、メインセッションにも簡潔なサマリーを投稿します。
  - `none`: 内部のみ（配信なし、メインセッションのサマリーなし）。
- `wakeMode` は、メインセッションへのサマリー投稿タイミングを制御します:
  - `now`: 即時ハートビート。
  - `next-heartbeat`: 次に予定されたハートビートまで待機。

メインのチャット履歴を汚したくない、ノイズが多い・高頻度な「バックグラウンド作業」には、分離ジョブを使用してください。

### ペイロード形状（実行内容）

サポートされるペイロードは 2 種類です:

- `systemEvent`: メインセッション専用。ハートビートプロンプト経由でルーティングされます。
- `agentTurn`: 分離セッション専用。専用のエージェントターンを実行します。

共通の `agentTurn` フィールド:

- `message`: 必須のテキストプロンプト
- `model` / `thinking`: 任意の上書き設定（後述）
- `timeoutSeconds`: 任意のタイムアウト上書き

配信設定（分離ジョブのみ）:

- `delivery.mode`: `none` | `announce`
- `delivery.channel`: `last` または特定のチャンネル
- `delivery.to`: チャンネル固有のターゲット（電話 / チャット / チャンネル ID）
- `delivery.bestEffort`: 通知配信が失敗してもジョブを失敗扱いにしない

通知配信では、その実行中のメッセージングツール送信が抑制されます。チャットを直接ターゲットにする場合は `delivery.channel` / `delivery.to` を使用してください。`delivery.mode = "none"` の場合、メインセッションへのサマリーは投稿されません。 `delivery.mode = "none"`の場合、メインセッションにサマリは投稿されません。

分離ジョブで `delivery` が省略された場合、OpenClaw はデフォルトで `announce` を使用します。

#### 通知配信フロー

`delivery.mode = "announce"` の場合、cron はアウトバウンドチャンネルアダプターを介して直接配信します。
メインエージェントはメッセージの作成や転送のために起動されません。
メインエージェントは、メッセージを作成または転送するためにスピンアップされません。

挙動の詳細:

- 内容: 配信は、分離実行のアウトバウンドペイロード（テキスト / メディア）を通常の分割とチャンネル整形で使用します。
- ハートビート専用の応答（実体のある内容を伴わない `HEARTBEAT_OK`）は配信されません。
- 分離実行がすでに同一ターゲットへメッセージツールで送信している場合、重複回避のため配信はスキップされます。
- 配信ターゲットが欠落または無効な場合、`delivery.bestEffort = true` がない限りジョブは失敗します。
- 短いサマリーは、`delivery.mode = "announce"` の場合にのみメインセッションへ投稿されます。
- メインセッションのサマリーは `wakeMode` に従います。`now` は即時ハートビート、`next-heartbeat` は次に予定されたハートビートを待機します。

### モデルおよび思考レベルの上書き

分離ジョブ（`agentTurn`）では、モデルと思考レベルを上書きできます:

- `model`: プロバイダー / モデル文字列（例: `anthropic/claude-sonnet-4-20250514`）またはエイリアス（例: `opus`）
- `thinking`: 思考レベル（`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex モデルのみ）

注記: メインセッションジョブでも `model` を設定できますが、共有されているメインセッションのモデルが変更されます。予期しないコンテキスト変更を避けるため、モデルの上書きは分離ジョブでのみ行うことを推奨します。
予期しないコンテキストシフトを避けるために、モデルのオーバーライドは分離されたジョブに対してのみ行うことをお勧めします。

解決優先順位:

1. ジョブペイロードの上書き（最優先）
2. フック固有のデフォルト（例: `hooks.gmail.model`）
3. エージェント設定のデフォルト

### 配信（チャンネル + ターゲット）

分離ジョブは、トップレベルの `delivery` 設定を通じてチャンネルに出力を配信できます:

- `delivery.mode`: `announce`（サマリーを配信）または `none`
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost`（プラグイン） / `signal` / `imessage` / `last`
- `delivery.to`: チャンネル固有の受信者ターゲット

配信設定は分離ジョブでのみ有効です（`sessionTarget: "isolated"`）。

`delivery.channel` または `delivery.to` が省略された場合、cron はメインセッションの「最後のルート」（エージェントが最後に返信した場所）にフォールバックできます。

ターゲット形式の注意点:

- Slack / Discord / Mattermost（プラグイン）のターゲットは、曖昧さを避けるため明示的なプレフィックス（例: `channel:<id>`, `user:<id>`）を使用してください。
- Telegram のトピックは `:topic:` 形式を使用してください（下記参照）。

#### Telegram の配信ターゲット（トピック / フォーラムスレッド）

Telegram は `message_thread_id` によるフォーラムトピックをサポートしています。cron 配信では、
トピック / スレッドを `to` フィールドにエンコードできます: 36. cron 配信では、トピック／スレッドを `to` フィールドにエンコードできます。

- `-1001234567890`（チャット ID のみ）
- `-1001234567890:topic:123`（推奨: 明示的なトピックマーカー）
- `-1001234567890:123`（省略形: 数値サフィックス）

`telegram:...` / `telegram:group:...` のようなプレフィックス付きターゲットも受け付けられます:

- `telegram:group:-1001234567890:topic:123`

## ツールコール用 JSON スキーマ

ゲートウェイ`cron.*`ツールを直接呼び出すときにこれらの図形を使用します（エージェントツールコールまたはRPC）。
Gateway の `cron.*` ツールを直接呼び出す場合（エージェントのツールコールまたは RPC）は、以下の形状を使用してください。
CLI フラグは `20m` のような人間可読な期間を受け付けますが、ツールコールでは
`schedule.at` には ISO 8601 文字列、`schedule.everyMs` にはミリ秒を使用してください。

### cron.add params

単発・メインセッションジョブ（システムイベント）:

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

配信付き・定期・分離ジョブ:

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

注記:

- `schedule.kind`: `at`（`at`）、`every`（`everyMs`）、または `cron`（`expr`、任意で `tz`）。
- `schedule.at` は ISO 8601 を受け付けます（タイムゾーン省略可。省略時は UTC として扱われます）。
- `everyMs` はミリ秒です。
- `sessionTarget` は `"main"` または `"isolated"` でなければならず、`payload.kind` と一致する必要があります。
- 任意フィールド: `agentId`, `description`, `enabled`, `deleteAfterRun`（`at` の場合はデフォルト true）,
  `delivery`。
- `wakeMode` は省略時に `"now"` がデフォルトになります。

### cron.update params

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

注記:

- `jobId` が正規であり、互換性のため `id` も受け付けます。
- エージェントバインディングを解除するには、パッチ内で `agentId: null` を使用してください。

### cron.run および cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## ストレージと履歴

- ジョブストア: `~/.openclaw/cron/jobs.json`（Gateway 管理の JSON）
- 実行履歴: `~/.openclaw/cron/runs/<jobId>.jsonl`（JSONL、自動的に剪定）
- ストアパスの上書き: 設定で `cron.store`

## 設定

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

cron を完全に無効化する:

- `cron.enabled: false`（設定）
- `OPENCLAW_SKIP_CRON=1`（環境変数）

## CLI クイックスタート

単発リマインダー（UTC ISO、成功後に自動削除）:

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

単発リマインダー（メインセッション、即時ウェイク）:

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

定期・分離ジョブ（WhatsApp に通知）:

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

定期・分離ジョブ（Telegram のトピックに配信）:

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

モデルと思考レベルを上書きした分離ジョブ:

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

エージェント選択（マルチエージェント構成）:

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

手動実行（force がデフォルト。期限到来時のみ実行するには `--due` を使用）:

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

既存ジョブの編集（フィールドをパッチ）:

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

実行履歴:

```bash
openclaw cron runs --id <jobId> --limit 50
```

ジョブを作成せずに即時システムイベントを実行:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API サーフェス

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run`（force または due）, `cron.runs`
  ジョブを作成せずに即時システムイベントを実行するには、[`openclaw system event`](/cli/system) を使用してください。

## トラブルシューティング

### 「何も実行されない」

- cron が有効になっているか確認してください: `cron.enabled` と `OPENCLAW_SKIP_CRON`。
- Gateway が継続的に稼働しているか確認してください（cron は Gateway プロセス内部で実行されます）。
- `cron` スケジュールの場合、タイムゾーン（`--tz`）とホストのタイムゾーンを確認してください。

### 定期ジョブが失敗後に遅延し続ける

- OpenClaw は、連続エラー後の定期ジョブに対して指数バックオフの再試行を適用します:
  30 秒、1 分、5 分、15 分、その後は 60 分間隔です。
- 次に成功した実行後、バックオフは自動的にリセットされます。
- 単発（`at`）ジョブは、終了状態（`ok`, `error`, または `skipped`）後に無効化され、再試行されません。

### Telegram が誤った場所に配信される

- フォーラムトピックの場合は、明示的で曖昧さのない `-100…:topic:<id>` を使用してください。
- ログや保存された「最後のルート」ターゲットに `telegram:...` プレフィックスが表示される場合がありますが、これは正常です。
  cron 配信はそれらを受け付け、トピック ID も正しく解析します。
