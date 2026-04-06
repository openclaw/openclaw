---
read_when:
    - cronが実行されなかった
    - cronは実行されたがメッセージが配信されなかった
    - ハートビートが無応答またはスキップされているようだ
summary: cronとハートビートのスケジューリングおよび配信のトラブルシューティング
title: 自動化のトラブルシューティング
x-i18n:
    generated_at: "2026-04-02T07:30:42Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6de27b8acac65a5dade3f61969fd6cbb77341d843c2a9aab4900aeed4803e710
    source_path: automation/troubleshooting.md
    workflow: 15
---

# 自動化のトラブルシューティング

このページは、スケジューラと配信の問題（`cron` + `heartbeat`）に使用します。

## コマンドラダー

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に自動化のチェックを実行します:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## cronが起動しない

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

正常な出力は以下のようになります:

- `cron status` が有効であり、未来の `nextWakeAtMs` を報告している。
- ジョブが有効で、有効なスケジュール/タイムゾーンを持っている。
- `cron runs` が `ok` または明示的なスキップ理由を表示している。

よくあるパターン:

- `cron: scheduler disabled; jobs will not run automatically` → 設定/環境変数でcronが無効になっている。
- `cron: timer tick failed` → スケジューラのtickがクラッシュした。前後のスタック/ログコンテキストを確認してください。
- 実行出力に `reason: not-due` → `--force` なしで手動実行が呼ばれ、ジョブがまだ実行予定でない。

## cronは起動したが配信されない

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

正常な出力は以下のようになります:

- 実行ステータスが `ok` である。
- 分離ジョブの配信モード/ターゲットが設定されている。
- チャネルプローブがターゲットチャネルの接続を報告している。

よくあるパターン:

- 実行は成功したが配信モードが `none` → 外部メッセージは期待されていない。
- 配信ターゲットが未設定/無効（`channel`/`to`）→ 実行は内部的に成功するが、送信をスキップする可能性がある。
- チャネル認証エラー（`unauthorized`、`missing_scope`、`Forbidden`）→ チャネルの認証情報/権限により配信がブロックされている。

## ハートビートが抑制またはスキップされる

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

正常な出力は以下のようになります:

- ハートビートが有効で、ゼロでないインターバルが設定されている。
- 最後のハートビート結果が `ran` である（またはスキップ理由が理解できる）。

よくあるパターン:

- `heartbeat skipped` で `reason=quiet-hours` → `activeHours` の範囲外。
- `requests-in-flight` → メインレーンがビジー。ハートビートが延期された。
- `empty-heartbeat-file` → `HEARTBEAT.md` にアクション可能なコンテンツがなく、タグ付きcronイベントもキューに入っていないため、インターバルハートビートがスキップされた。
- `alerts-disabled` → 表示設定により送信ハートビートメッセージが抑制されている。

## タイムゾーンとactiveHoursの注意点

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

基本ルール:

- `Config path not found: agents.defaults.userTimezone` はキーが未設定であることを意味します。ハートビートはホストのタイムゾーンにフォールバックします（`activeHours.timezone` が設定されている場合はそちらを使用）。
- `--tz` なしのcronはGateway ゲートウェイのホストタイムゾーンを使用します。
- ハートビートの `activeHours` は設定されたタイムゾーン解決（`user`、`local`、または明示的なIANA tz）を使用します。
- cronの `at` スケジュールは、`--at "<offset-less-iso>" --tz <iana>` を使用しない限り、タイムゾーンなしのISOタイムスタンプをUTCとして扱います。

よくあるパターン:

- ホストのタイムゾーン変更後、ジョブが間違った壁時計時刻に実行される。
- `activeHours.timezone` が間違っているため、日中でもハートビートが常にスキップされる。

関連:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
