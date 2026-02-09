---
summary: "自動化において Heartbeat と cron ジョブのどちらを選ぶべきかの指針"
read_when:
  - 定期タスクのスケジューリング方法を決めるとき
  - バックグラウンド監視や通知を設定するとき
  - 定期チェックにおけるトークン使用量を最適化したいとき
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat：それぞれを使うべき場面

Heartbeat と cron ジョブはいずれも、スケジュールに従ってタスクを実行できます。本ガイドでは、ユースケースに適した仕組みを選ぶための指針を示します。 このガイドは、ユースケースに適したメカニズムを選択するのに役立ちます。

## クイック判断ガイド

| ユースケース                 | 推奨               | 理由                    |
| ---------------------- | ---------------- | --------------------- |
| 30 分ごとに受信箱をチェック        | Heartbeat        | 他のチェックとバッチ化でき、文脈を考慮可能 |
| 毎日きっかり 9 時にレポート送信      | Cron（分離）         | 正確なタイミングが必要           |
| 予定されているイベントの監視         | Heartbeat        | 定期的な把握に自然に適合          |
| 週次の詳細分析を実行             | Cron（分離）         | 単独タスクで、別モデルを使用可能      |
| 20分後に通知する              | Cron（メイン、`--at`） | 正確なタイミングのワンショット       |
| バックグラウンドのプロジェクト健全性チェック | Heartbeat        | 既存のサイクルに相乗りできる        |

## Heartbeat：定期的な把握

Heartbeat は **メインセッション** で一定間隔（デフォルト：30 分）ごとに実行されます。エージェントが状況を確認し、重要な点を浮き彫りにすることを目的としています。 彼らはエージェントが何かをチェックし、重要なものを表面化するように設計されています。

### Heartbeat を使うべき場合

- **複数の定期チェック**：受信箱、カレンダー、天気、通知、プロジェクト状況をそれぞれ 5 つの cron ジョブで確認する代わりに、1 つの Heartbeat でまとめて処理できます。
- **文脈を考慮した判断**：エージェントはメインセッションの完全な文脈を持つため、緊急度の高いものと待てるものを賢く判断できます。
- **会話の連続性**：Heartbeat の実行は同じセッションを共有するため、直近の会話を記憶し、自然にフォローアップできます。
- **低オーバーヘッドの監視**：1 つの Heartbeat が多数の小さなポーリングタスクを置き換えます。

### Heartbeat の利点

- **複数チェックのバッチ化**：1 回のエージェントターンで、受信箱、カレンダー、通知をまとめて確認できます。
- **API コールの削減**：5 つの分離された cron ジョブよりも、単一の Heartbeat の方が低コストです。
- **文脈認識**：エージェントは現在取り組んでいる内容を把握し、優先順位付けができます。
- **スマート抑制**：注意が必要な事項がない場合、エージェントは `HEARTBEAT_OK` と応答し、メッセージは配信されません。
- **自然なタイミング**：キュー負荷に応じて多少ずれますが、ほとんどの監視用途では問題ありません。

### Heartbeat の例：HEARTBEAT.md チェックリスト

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

エージェントは各 Heartbeat ごとにこれを読み取り、すべての項目を 1 ターンで処理します。

### Heartbeat の設定

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

詳細な設定については [Heartbeat](/gateway/heartbeat) を参照してください。

## Cron：正確なスケジューリング

Cron ジョブは **正確な時刻** に実行され、メインの文脈に影響を与えない分離セッションで実行できます。

### Cron を使うべき場合

- **正確なタイミングが必要**：「毎週月曜の午前 9:00 ちょうどに送信」（「9 時頃」ではない）。
- **単独タスク**：会話の文脈を必要としないタスク。
- **異なるモデル／思考**：より強力なモデルを必要とする重い分析。
- **ワンショットのリマインダー**：`--at` を伴う「20 分後にリマインド」。
- **ノイズが多い／頻繁なタスク**：メインセッションの履歴を散らかしてしまうタスク。
- **外部トリガー**：エージェントが他でアクティブであるかどうかに関係なく実行すべきタスク。

### Cron の利点

- **正確なタイミング**：タイムゾーン対応の 5 フィールド cron 式。
- **セッション分離**：`cron:<jobId>` で実行され、メイン履歴を汚しません。
- **モデルの上書き**：ジョブごとに安価または高性能なモデルを選択できます。
- **配信制御**：分離ジョブはデフォルトで `announce`（要約）です。必要に応じて `none` を選択できます。
- **即時配信**：アナウンスモードでは、Heartbeat を待たずに直接投稿します。
- **エージェント文脈不要**：メインセッションがアイドル状態や圧縮済みでも実行されます。
- **ワンショット対応**：正確な将来時刻のための `--at`。

### Cron の例：毎朝のブリーフィング

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

これはニューヨーク時間の午前 7:00 ちょうどに実行され、品質のために Opus を使用し、要約を WhatsApp に直接アナウンスします。

### Cron の例：ワンショットのリマインダー

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

完全な CLI リファレンスについては [Cron jobs](/automation/cron-jobs) を参照してください。

## 判断フローチャート

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## 両者の併用

最も効率的なセットアップは **両方** を使用します。

1. **Heartbeat** は、30 分ごとに 1 回のバッチ処理で、受信箱、カレンダー、通知といった定常的な監視を担当します。
2. **Cron** は、正確なスケジュール（毎日のレポート、週次レビュー）やワンショットのリマインダーを担当します。

### 例：効率的な自動化セットアップ

**HEARTBEAT.md**（30 分ごとにチェック）：

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron ジョブ**（正確なタイミング）：

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster：承認付きの決定論的ワークフロー

Lobster は、**マルチステップのツールパイプライン** に対して、決定論的な実行と明示的な承認を提供するワークフローランタイムです。  
単一のエージェントターンを超えるタスクで、人間のチェックポイントを伴う再開可能なワークフローが必要な場合に使用します。
タスクが単一のエージェントターン以上の場合に使用し、ヒューマンチェックポイントで再開可能なワークフローが必要です。

### Lobster が適する場合

- **マルチステップ自動化**：一度きりのプロンプトではなく、固定されたツール呼び出しパイプラインが必要な場合。
- **承認ゲート**：副作用のある処理を承認まで一時停止し、その後再開したい場合。
- **再開可能な実行**：以前のステップを再実行せずに、一時停止したワークフローを継続したい場合。

### Heartbeat と cron との組み合わせ方

- **Heartbeat／cron** は「いつ」実行するかを決定します。
- **Lobster** は実行開始後に「どのステップ」を行うかを定義します。

スケジュールされたワークフローでは、cron または Heartbeat を使って Lobster を呼び出すエージェントターンをトリガーします。  
アドホックなワークフローでは、Lobster を直接呼び出します。
アドホックワークフローの場合は、ロブスターに直接電話してください。

### 運用上の注記（コードより）

- Lobster はツールモードで **ローカルサブプロセス**（`lobster` CLI）として実行され、**JSON エンベロープ**を返します。
- ツールが `needs_approval` を返した場合、`resumeToken` と `approve` フラグを付けて再開します。
- このツールは **オプションのプラグイン** であり、`tools.alsoAllow: ["lobster"]` により追加的に有効化します（推奨）。
- `lobsterPath` を渡す場合、それは **絶対パス** である必要があります。

完全な使用方法と例については [Lobster](/tools/lobster) を参照してください。

## メインセッション vs 分離セッション

Heartbeat と cron はどちらもメインセッションと相互作用できますが、その方法は異なります。

|       | Heartbeat               | Cron（メイン）              | Cron（分離）        |
| ----- | ----------------------- | ---------------------- | --------------- |
| セッション | メイン                     | メイン（システムイベント経由）        | `cron:<jobId>`  |
| 履歴    | 共有                      | 共有                     | 実行ごとに新規         |
| 文脈    | 完全                      | 完全                     | なし（クリーンスタート）    |
| モデル   | メインセッションのモデル            | メインセッションのモデル           | 上書き可能           |
| 出力    | `HEARTBEAT_OK` でない場合に配信 | Heartbeat プロンプト + イベント | 要約をアナウンス（デフォルト） |

### メインセッション cron を使う場合

次のことを望む場合は、`--session main` を `--system-event` と共に使用します。

- リマインダー／イベントをメインセッションの文脈に表示したい
- 次の Heartbeat 時に、完全な文脈でエージェントに処理させたい
- 別の分離実行を作りたくない

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### 分離 cron を使う場合

次のことを望む場合は、`--session isolated` を使用します。

- 事前の文脈がないクリーンな状態
- 異なるモデルや思考設定
- チャンネルへの要約の直接アナウンス
- メインセッションを汚さない履歴

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## コストに関する考慮事項

| 仕組み       | コスト特性                                             |
| --------- | ------------------------------------------------- |
| Heartbeat | N 分ごとに 1 ターン；HEARTBEAT.md のサイズに比例 |
| Cron（メイン） | 次の Heartbeat にイベントを追加（分離ターンなし）                    |
| Cron（分離）  | ジョブごとに完全なエージェントターン；安価なモデルを使用可能                    |

**ヒント**：

- トークンオーバーヘッドを最小化するため、`HEARTBEAT.md` は小さく保ってください。
- 複数の cron ジョブではなく、類似したチェックは Heartbeat にまとめてください。
- 内部処理のみが必要な場合は、Heartbeat で `target: "none"` を使用してください。
- 定常タスクには、安価なモデルを使った分離 cron を活用してください。

## 関連

- [Heartbeat](/gateway/heartbeat) - Heartbeat の完全な設定
- [Cron jobs](/automation/cron-jobs) - cron CLI と API の完全なリファレンス
- [System](/cli/system) - システムイベントと Heartbeat 制御
