---
summary: "cron とハートビートのスケジューリングとデリバリーをトラブルシューティングする"
read_when:
  - Cron が実行されなかった
  - Cron は実行されたがメッセージが配信されなかった
  - ハートビートが無音またはスキップされているように見える
title: "自動化トラブルシューティング"
---

# 自動化トラブルシューティング

このページはスケジューラーとデリバリーの問題（`cron` + `heartbeat`）に使用してください。

## コマンドラダー

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に自動化チェックを実行します:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron が発火しない

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

正常な出力の例:

- `cron status` が enabled と将来の `nextWakeAtMs` を報告する。
- ジョブが有効で有効なスケジュール/タイムゾーンを持つ。
- `cron runs` が `ok` または明示的なスキップ理由を表示する。

一般的なシグネチャ:

- `cron: scheduler disabled; jobs will not run automatically` → 設定/環境変数で Cron が無効になっている。
- `cron: timer tick failed` → スケジューラーのティックがクラッシュした。周辺のスタック/ログコンテキストを調査してください。
- 実行出力の `reason: not-due` → `--force` なしで手動実行が呼び出されたがジョブがまだ期限になっていない。

## Cron は発火したがデリバリーされない

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

正常な出力の例:

- 実行ステータスが `ok`。
- アイソレーテッドジョブのデリバリーモード/ターゲットが設定されている。
- チャンネルプローブがターゲットチャンネルの接続を報告する。

一般的なシグネチャ:

- 実行成功だがデリバリーモードが `none` → 外部メッセージは期待されない。
- デリバリーターゲットが欠落/無効（`channel`/`to`） → 実行は内部で成功するかもしれないがアウトバウンドをスキップする。
- チャンネル認証エラー（`unauthorized`、`missing_scope`、`Forbidden`） → チャンネルの認証情報/パーミッションによってデリバリーがブロックされている。

## ハートビートが抑制またはスキップされている

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

正常な出力の例:

- ハートビートが非ゼロ間隔で有効になっている。
- 最後のハートビート結果が `ran`（またはスキップ理由が理解できる）。

一般的なシグネチャ:

- `heartbeat skipped` と `reason=quiet-hours` → `activeHours` の外。
- `requests-in-flight` → メインレーンがビジー。ハートビートが延期された。
- `empty-heartbeat-file` → `HEARTBEAT.md` に実行可能なコンテンツがなく、タグ付きの cron イベントもキューにないため、間隔ハートビートがスキップされた。
- `alerts-disabled` → 表示設定がアウトバウンドハートビートメッセージを抑制している。

## タイムゾーンと activeHours の注意点

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

クイックルール:

- `Config path not found: agents.defaults.userTimezone` はキーが未設定であることを意味します。ハートビートはホストタイムゾーン（または `activeHours.timezone` が設定されている場合）にフォールバックします。
- `--tz` なしの Cron は Gateway ホストのタイムゾーンを使用します。
- ハートビートの `activeHours` は設定されたタイムゾーン解決（`user`、`local`、または明示的な IANA tz）を使用します。
- タイムゾーンなしの ISO タイムスタンプは Cron の `at` スケジュールで UTC として扱われます。

一般的なシグネチャ:

- ホストのタイムゾーン変更後にジョブが間違った実時刻で実行される。
- `activeHours.timezone` が間違っているため、日中はハートビートが常にスキップされる。

関連リンク:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
