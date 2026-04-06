---
read_when:
    - cron ジョブを作成せずにシステムイベントをキューに追加したい場合
    - ハートビートを有効化または無効化する必要がある場合
    - システムプレゼンスエントリを確認したい場合
summary: '`openclaw system`（システムイベント、ハートビート、プレゼンス）の CLI リファレンス'
title: system
x-i18n:
    generated_at: "2026-04-02T07:36:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 36ae5dbdec327f5a32f7ef44bdc1f161bad69868de62f5071bb4d25a71bfdfe9
    source_path: cli/system.md
    workflow: 15
---

# `openclaw system`

Gateway のシステムレベルヘルパー: システムイベントのキュー追加、ハートビートの制御、プレゼンスの表示を行います。

## よく使うコマンド

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

**メイン**セッションにシステムイベントをキューに追加します。次のハートビート時にプロンプト内の `System:` 行として挿入されます。`--mode now` を使用するとハートビートを即座にトリガーし、`next-heartbeat` は次のスケジュールされたティックを待ちます。

フラグ:

- `--text <text>`: 必須のシステムイベントテキスト。
- `--mode <mode>`: `now` または `next-heartbeat`（デフォルト）。
- `--json`: 機械可読な出力。

## `system heartbeat last|enable|disable`

ハートビートの制御:

- `last`: 最後のハートビートイベントを表示します。
- `enable`: ハートビートを再度有効にします（無効化されていた場合に使用）。
- `disable`: ハートビートを一時停止します。

フラグ:

- `--json`: 機械可読な出力。

## `system presence`

Gateway が認識している現在のシステムプレゼンスエントリ（ノード、インスタンス、および類似のステータス行）を一覧表示します。

フラグ:

- `--json`: 機械可読な出力。

## 注意事項

- 現在の設定（ローカルまたはリモート）で到達可能な実行中の Gateway が必要です。
- システムイベントは一時的なもので、再起動後は保持されません。
