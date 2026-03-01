---
summary: "`openclaw cron` のCLIリファレンス（バックグラウンドジョブのスケジュールと実行）"
read_when:
  - スケジュールジョブとウェイクアップを設定したい場合
  - cronの実行とログをデバッグしている場合
title: "cron"
---

# `openclaw cron`

Gatewayスケジューラーのcronジョブを管理します。

関連：

- Cronジョブ：[Cron jobs](/automation/cron-jobs)

ヒント：完全なコマンド一覧は `openclaw cron --help` を実行してください。

注意：分離された `cron add` ジョブはデフォルトで `--announce` 配信になります。出力を内部に保持するには `--no-deliver` を使用してください。`--deliver` は `--announce` の非推奨エイリアスとして残っています。

注意：ワンショット（`--at`）ジョブは成功後にデフォルトで削除されます。保持するには `--keep-after-run` を使用してください。

注意：定期ジョブは連続エラー後に指数バックオフリトライを使用するようになりました（30秒 → 1分 → 5分 → 15分 → 60分）。次の成功した実行後に通常のスケジュールに戻ります。

注意：保持/プルーニングは設定で制御されます：

- `cron.sessionRetention`（デフォルト `24h`）は完了した分離実行セッションをプルーニングします。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` は `~/.openclaw/cron/runs/<jobId>.jsonl` をプルーニングします。

## 一般的な編集

メッセージを変更せずに配信設定を更新：

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

分離されたジョブの配信を無効化：

```bash
openclaw cron edit <job-id> --no-deliver
```

特定のチャネルにアナウンス：

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
