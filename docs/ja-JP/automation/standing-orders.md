---
read_when:
    - タスクごとのプロンプトなしで実行される自律型エージェントワークフローのセットアップ時
    - エージェントが独立して実行できることと人間の承認が必要なことの定義時
    - 明確な境界とエスカレーションルールを持つマルチプログラムエージェントの構築時
summary: 自律型エージェントプログラムの恒久的な運用権限を定義する
title: スタンディングオーダー
x-i18n:
    generated_at: "2026-04-02T07:30:53Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 3fe5136aeffdbaf83f4b03ef0a75859ba1a19d3241af6b0162c40cb0de2f06c0
    source_path: automation/standing-orders.md
    workflow: 15
---

# スタンディングオーダー

スタンディングオーダーは、定義されたプログラムに対してエージェントに**恒久的な運用権限**を付与します。毎回個別のタスク指示を出す代わりに、明確なスコープ、トリガー、エスカレーションルールを持つプログラムを定義し、エージェントはその境界内で自律的に実行します。

これは、毎週金曜日にアシスタントに「週次レポートを送って」と伝えることと、恒久的な権限を付与することの違いです:「週次レポートはあなたの担当です。毎週金曜日にまとめて送信し、何か問題がある場合のみエスカレーションしてください。」

## なぜスタンディングオーダーが必要か？

**スタンディングオーダーがない場合:**

- すべてのタスクでエージェントにプロンプトを出す必要がある
- リクエスト間でエージェントはアイドル状態になる
- ルーティン作業が忘れられたり遅延したりする
- あなたがボトルネックになる

**スタンディングオーダーがある場合:**

- エージェントは定義された境界内で自律的に実行する
- ルーティン作業はプロンプトなしでスケジュール通りに実行される
- あなたが関与するのは例外と承認のみ
- エージェントはアイドル時間を生産的に活用する

## 仕組み

スタンディングオーダーは[エージェントワークスペース](/concepts/agent-workspace)のファイルで定義します。推奨されるアプローチは、`AGENTS.md`（毎セッション自動注入される）に直接含めることで、エージェントが常にコンテキスト内にそれを持つようにすることです。設定が大きい場合は、`standing-orders.md` のような専用ファイルに配置し、`AGENTS.md` から参照することもできます。

各プログラムは以下を指定します:

1. **スコープ** — エージェントが実行を許可されていること
2. **トリガー** — いつ実行するか（スケジュール、イベント、または条件）
3. **承認ゲート** — 実行前に人間の承認が必要なこと
4. **エスカレーションルール** — いつ停止して助けを求めるか

エージェントはワークスペースのブートストラップファイル（自動注入されるファイルの完全なリストは[エージェントワークスペース](/concepts/agent-workspace)を参照）を通じてこれらの指示を毎セッション読み込み、時間ベースの強制実行のための[cronジョブ](/automation/cron-jobs)と組み合わせて実行します。

<Tip>
スタンディングオーダーは `AGENTS.md` に記述して、毎セッション確実に読み込まれるようにしましょう。ワークスペースのブートストラップは `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`、`MEMORY.md` を自動的に注入しますが、サブディレクトリ内の任意のファイルは注入しません。
</Tip>

## スタンディングオーダーの構造

```markdown
## Program: Weekly Status Report

**Authority:** Compile data, generate report, deliver to stakeholders
**Trigger:** Every Friday at 4 PM (enforced via cron job)
**Approval gate:** None for standard reports. Flag anomalies for human review.
**Escalation:** If data source is unavailable or metrics look unusual (>2σ from norm)

### Execution Steps

1. Pull metrics from configured sources
2. Compare to prior week and targets
3. Generate report in Reports/weekly/YYYY-MM-DD.md
4. Deliver summary via configured channel
5. Log completion to Agent/Logs/

### What NOT to Do

- Do not send reports to external parties
- Do not modify source data
- Do not skip delivery if metrics look bad — report accurately
```

## スタンディングオーダー + cronジョブ

スタンディングオーダーはエージェントが**何を**実行する権限があるかを定義します。[cronジョブ](/automation/cron-jobs)は**いつ**実行するかを定義します。これらは連携して動作します:

```
Standing Order: "You own the daily inbox triage"
    ↓
Cron Job (8 AM daily): "Execute inbox triage per standing orders"
    ↓
Agent: Reads standing orders → executes steps → reports results
```

cronジョブのプロンプトはスタンディングオーダーを複製するのではなく、参照するようにしてください:

```bash
openclaw cron add \
  --name daily-inbox-triage \
  --cron "0 8 * * 1-5" \
  --tz America/New_York \
  --timeout-seconds 300 \
  --announce \
  --channel bluebubbles \
  --to "+1XXXXXXXXXX" \
  --message "Execute daily inbox triage per standing orders. Check mail for new alerts. Parse, categorize, and persist each item. Report summary to owner. Escalate unknowns."
```

## 例

### 例 1: コンテンツ & ソーシャルメディア（週次サイクル）

```markdown
## Program: Content & Social Media

**Authority:** Draft content, schedule posts, compile engagement reports
**Approval gate:** All posts require owner review for first 30 days, then standing approval
**Trigger:** Weekly cycle (Monday review → mid-week drafts → Friday brief)

### Weekly Cycle

- **Monday:** Review platform metrics and audience engagement
- **Tuesday–Thursday:** Draft social posts, create blog content
- **Friday:** Compile weekly marketing brief → deliver to owner

### Content Rules

- Voice must match the brand (see SOUL.md or brand voice guide)
- Never identify as AI in public-facing content
- Include metrics when available
- Focus on value to audience, not self-promotion
```

### 例 2: 財務オペレーション（イベントトリガー）

```markdown
## Program: Financial Processing

**Authority:** Process transaction data, generate reports, send summaries
**Approval gate:** None for analysis. Recommendations require owner approval.
**Trigger:** New data file detected OR scheduled monthly cycle

### When New Data Arrives

1. Detect new file in designated input directory
2. Parse and categorize all transactions
3. Compare against budget targets
4. Flag: unusual items, threshold breaches, new recurring charges
5. Generate report in designated output directory
6. Deliver summary to owner via configured channel

### Escalation Rules

- Single item > $500: immediate alert
- Category > budget by 20%: flag in report
- Unrecognizable transaction: ask owner for categorization
- Failed processing after 2 retries: report failure, do not guess
```

### 例 3: モニタリング & アラート（継続的）

```markdown
## Program: System Monitoring

**Authority:** Check system health, restart services, send alerts
**Approval gate:** Restart services automatically. Escalate if restart fails twice.
**Trigger:** Every heartbeat cycle

### Checks

- Service health endpoints responding
- Disk space above threshold
- Pending tasks not stale (>24 hours)
- Delivery channels operational

### Response Matrix

| Condition        | Action                   | Escalate?                |
| ---------------- | ------------------------ | ------------------------ |
| Service down     | Restart automatically    | Only if restart fails 2x |
| Disk space < 10% | Alert owner              | Yes                      |
| Stale task > 24h | Remind owner             | No                       |
| Channel offline  | Log and retry next cycle | If offline > 2 hours     |
```

## 実行-検証-報告パターン

スタンディングオーダーは、厳格な実行規律と組み合わせることで最も効果的に機能します。スタンディングオーダー内のすべてのタスクは、このループに従うべきです:

1. **実行** — 実際の作業を行う（指示を認識するだけではない）
2. **検証** — 結果が正しいことを確認する（ファイルが存在する、メッセージが配信された、データが解析された）
3. **報告** — 何を行い、何を検証したかをオーナーに伝える

```markdown
### Execution Rules

- Every task follows Execute-Verify-Report. No exceptions.
- "I'll do that" is not execution. Do it, then report.
- "Done" without verification is not acceptable. Prove it.
- If execution fails: retry once with adjusted approach.
- If still fails: report failure with diagnosis. Never silently fail.
- Never retry indefinitely — 3 attempts max, then escalate.
```

このパターンは、エージェントの最も一般的な失敗モード、つまりタスクを完了せずに認識することを防ぎます。

## マルチプログラムアーキテクチャ

複数の関心事を管理するエージェントの場合、スタンディングオーダーを明確な境界を持つ別々のプログラムとして整理します:

```markdown
# Standing Orders

## Program 1: [Domain A] (Weekly)

...

## Program 2: [Domain B] (Monthly + On-Demand)

...

## Program 3: [Domain C] (As-Needed)

...

## Escalation Rules (All Programs)

- [Common escalation criteria]
- [Approval gates that apply across programs]
```

各プログラムは以下を持つべきです:

- 独自の**トリガー頻度**（週次、月次、イベント駆動、継続的）
- 独自の**承認ゲート**（プログラムによって必要な監視レベルが異なる）
- 明確な**境界**（エージェントはあるプログラムがどこで終わり、別のプログラムがどこで始まるかを知るべき）

## ベストプラクティス

### 推奨

- 狭い権限から始めて、信頼が築かれるにつれて拡大する
- リスクの高いアクションには明示的な承認ゲートを定義する
- 「やってはいけないこと」セクションを含める — 境界は許可と同じくらい重要
- 信頼性の高い時間ベースの実行のためにcronジョブと組み合わせる
- スタンディングオーダーが遵守されていることを確認するためにエージェントのログを毎週レビューする
- ニーズの変化に合わせてスタンディングオーダーを更新する — これは生きたドキュメント

### 避けるべきこと

- 初日から広範な権限を付与する（「最善と思うことを何でもやって」）
- エスカレーションルールを省略する — すべてのプログラムに「いつ停止して確認するか」の条項が必要
- エージェントが口頭の指示を覚えていると仮定する — すべてをファイルに記述する
- 単一のプログラムに関心事を混在させる — ドメインごとにプログラムを分離する
- cronジョブによる強制実行を忘れる — トリガーのないスタンディングオーダーは単なる提案になる

## 関連

- [自動化の概要](/automation) — すべての自動化メカニズムを一覧
- [cronジョブ](/automation/cron-jobs) — スタンディングオーダーのスケジュール強制実行
- [フック](/automation/hooks) — エージェントライフサイクルイベントのイベント駆動スクリプト
- [Webhook](/automation/webhook) — インバウンド HTTP イベントトリガー
- [エージェントワークスペース](/concepts/agent-workspace) — スタンディングオーダーの配置場所、自動注入されるブートストラップファイル（AGENTS.md、SOUL.md など）の完全なリストを含む
