---
summary: "「openclaw cron」の CLI リファレンス（バックグラウンドジョブのスケジュールと実行）"
read_when:
  - スケジュールされたジョブやウェイクアップが必要な場合
  - cron の実行やログをデバッグしている場合
title: "cron"
---

# `openclaw cron`

Gateway スケジューラ向けの cron ジョブを管理します。

関連項目:

- Cron ジョブ: [Cron jobs](/automation/cron-jobs)

ヒント: コマンド全体の一覧は `openclaw cron --help` を実行してください。

注記: 分離された `cron add` ジョブは、既定で `--announce` 配信になります。出力を内部のみに保つには `--no-deliver` を使用してください。`--deliver` は `--announce` の非推奨エイリアスとして引き続き使用できます。
の出力を内部に保つには、 `--no-deliver` を使用します。 `--deliver` は `--announce` のエイリアスとして非推奨のままです。

注記: 単発（`--at`）ジョブは、既定では成功後に削除されます。保持するには `--keep-after-run` を使用してください。 `--keep-after-run` を使ってください。

注記: 定期ジョブは、連続したエラー後に指数的リトライバックオフ（30s → 1m → 5m → 15m → 60m）を使用し、次に成功した実行後は通常のスケジュールに戻ります。

## 一般的な編集

メッセージを変更せずに配信設定を更新します:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

分離されたジョブの配信を無効化します:

```bash
openclaw cron edit <job-id> --no-deliver
```

特定のチャンネルに通知します:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
