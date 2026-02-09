---
summary: "cron と Heartbeat のスケジューリングおよび配信に関するトラブルシューティング"
read_when:
  - Cron が実行されなかった
  - Cron は実行されたがメッセージが配信されなかった
  - Heartbeat が無音またはスキップされているように見える
title: "オートメーションのトラブルシューティング"
---

# オートメーションのトラブルシューティング

スケジューラーおよび配信に関する問題には、このページを使用してください（`cron` + `heartbeat`）。

## コマンドラダー

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に、オートメーションのチェックを実行します。

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron が起動しない

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

良好な出力の例：

- `cron status` が有効で、将来の `nextWakeAtMs` が報告されている。
- ジョブが有効で、有効なスケジュール／タイムゾーンを持っている。
- `cron runs` に `ok`、または明示的なスキップ理由が表示されている。

一般的なシグネチャ：

- `cron: scheduler disabled; jobs will not run automatically` → 設定／環境変数で cron が無効。
- `cron: timer tick failed` → スケジューラーのティックがクラッシュ。周辺のスタック／ログコンテキストを確認してください。
- 実行出力に `reason: not-due` → `--force` なしで手動実行が呼ばれ、ジョブがまだ実行時刻に達していない。

## Cron は起動したが配信されない

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

良好な出力の例：

- 実行ステータスが `ok`。
- 分離ジョブ向けに配信モード／ターゲットが設定されている。
- チャンネルプローブがターゲットチャンネルの接続を報告している。

一般的なシグネチャ：

- 実行は成功したが、配信モードが `none` → 外部メッセージは期待されない。
- 配信ターゲットが欠落／無効（`channel`/`to`）→ 内部的には成功しても、外部送信はスキップされる場合がある。
- チャンネル認証エラー（`unauthorized`、`missing_scope`、`Forbidden`）→ チャンネルの資格情報／権限により配信がブロックされている。

## Heartbeat が抑制またはスキップされる

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

良好な出力の例：

- Heartbeat が有効で、ゼロ以外の間隔が設定されている。
- 最後の Heartbeat の結果が `ran`（またはスキップ理由が理解できる）。

一般的なシグネチャ：

- `heartbeat skipped` と `reason=quiet-hours` → `activeHours` の外。
- `requests-in-flight` → メインレーンがビジーで、Heartbeat が延期された。
- `empty-heartbeat-file` → `HEARTBEAT.md` は存在するが、実行可能な内容がない。
- `alerts-disabled` → 可視性設定により、外向きの Heartbeat メッセージが抑制されている。

## タイムゾーンと activeHours の落とし穴

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

クイックルール：

- `Config path not found: agents.defaults.userTimezone` はキーが未設定であることを意味し、Heartbeat はホストのタイムゾーン（または設定されていれば `activeHours.timezone`）にフォールバックします。
- `--tz` のない Cron は、ゲートウェイ ホストのタイムゾーンを使用します。
- Heartbeat の `activeHours` は、設定されたタイムゾーン解決（`user`、`local`、または明示的な IANA tz）を使用します。
- タイムゾーンなしの ISO タイムスタンプは、Cron の `at` スケジュールでは UTC として扱われます。

一般的なシグネチャ：

- ホストのタイムゾーン変更後、ジョブが誤った実時間で実行される。
- `activeHours.timezone` が誤っているため、日中は常に Heartbeat がスキップされる。

関連：

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
