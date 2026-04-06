---
read_when:
    - スケジュールジョブとウェイクアップを設定したい
    - cronの実行とログをデバッグしている
summary: '`openclaw cron`（バックグラウンドジョブのスケジュールと実行）のCLIリファレンス'
title: cron
x-i18n:
    generated_at: "2026-04-02T07:33:17Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 10971c0d3952419caaba922c4f30943adfa6b2b73d58a971f03af8d7f4da1140
    source_path: cli/cron.md
    workflow: 15
---

# `openclaw cron`

Gateway ゲートウェイスケジューラのcronジョブを管理します。

関連:

- cronジョブ: [cronジョブ](/automation/cron-jobs)

ヒント: `openclaw cron --help`で完全なコマンド一覧を確認できます。

注意: 分離された`cron add`ジョブはデフォルトで`--announce`配信になります。出力を内部に留めるには`--no-deliver`を使用してください。`--deliver`は`--announce`の非推奨エイリアスとして残っています。

注意: ワンショット（`--at`）ジョブは成功後にデフォルトで削除されます。保持するには`--keep-after-run`を使用してください。

注意: ワンショットCLIジョブでは、オフセットなしの`--at`日時は`--tz <iana>`も指定しない限りUTCとして扱われます。`--tz`を指定すると、そのローカル壁時計時刻が指定されたタイムゾーンで解釈されます。

注意: 定期ジョブは連続エラー後に指数バックオフリトライを使用するようになりました（30秒 → 1分 → 5分 → 15分 → 60分）。次の成功した実行後に通常のスケジュールに戻ります。

注意: `openclaw cron run`は手動実行がキューに入れられた時点で返るようになりました。成功レスポンスには`{ ok: true, enqueued: true, runId }`が含まれます。最終的な結果を確認するには`openclaw cron runs --id <job-id>`を使用してください。

注意: 保持/プルーニングは設定で制御されます:

- `cron.sessionRetention`（デフォルト`24h`）は完了した分離実行セッションをプルーニングします。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines`は`~/.openclaw/cron/runs/<jobId>.jsonl`をプルーニングします。

アップグレード時の注意: 現在の配信/ストア形式より前の古いcronジョブがある場合は、`openclaw doctor --fix`を実行してください。Doctorはレガシーcronフィールド（`jobId`、`schedule.cron`、レガシーの`threadId`を含むトップレベル配信フィールド、ペイロードの`provider`配信エイリアス）を正規化し、`cron.webhook`が設定されている場合は単純な`notify: true`のWebhookフォールバックジョブを明示的なWebhook配信に移行します。

## よく使う編集

メッセージを変更せずに配信設定を更新:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

分離ジョブの配信を無効化:

```bash
openclaw cron edit <job-id> --no-deliver
```

分離ジョブの軽量ブートストラップコンテキストを有効化:

```bash
openclaw cron edit <job-id> --light-context
```

特定のチャネルにアナウンス:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

軽量ブートストラップコンテキスト付きの分離ジョブを作成:

```bash
openclaw cron add \
  --name "Lightweight morning brief" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize overnight updates." \
  --light-context \
  --no-deliver
```

`--light-context`は分離エージェントターンジョブにのみ適用されます。cron実行では、軽量モードは完全なワークスペースブートストラップセットを注入する代わりにブートストラップコンテキストを空のままにします。
