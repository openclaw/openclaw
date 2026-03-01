---
summary: "`openclaw system` の CLI リファレンス（システムイベント、ハートビート、プレゼンス）"
read_when:
  - cron ジョブを作成せずにシステムイベントをエンキューしたい場合
  - ハートビートの有効化または無効化
  - システムプレゼンスエントリの確認
title: "system"
---

# `openclaw system`

Gateway のシステムレベルヘルパー: システムイベントのエンキュー、ハートビートの制御、
プレゼンスの表示を行います。

## 一般的なコマンド

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

**メイン**セッションにシステムイベントをエンキューします。次のハートビートで
プロンプトに `System:` 行として注入されます。`--mode now` を使用するとハートビートを
即座にトリガーします。`next-heartbeat` は次のスケジュールされたティックを待ちます。

フラグ:

- `--text <text>`: 必須のシステムイベントテキスト。
- `--mode <mode>`: `now` または `next-heartbeat`（デフォルト）。
- `--json`: 機械可読な出力。

## `system heartbeat last|enable|disable`

ハートビートの制御:

- `last`: 最後のハートビートイベントを表示します。
- `enable`: ハートビートを再度オンにします（無効化されていた場合に使用します）。
- `disable`: ハートビートを一時停止します。

フラグ:

- `--json`: 機械可読な出力。

## `system presence`

Gateway が認識している現在のシステムプレゼンスエントリ（ノード、
インスタンス、および類似のステータス行）を一覧表示します。

フラグ:

- `--json`: 機械可読な出力。

## 注意事項

- 現在の設定で到達可能な実行中の Gateway が必要です（ローカルまたはリモート）。
- システムイベントはエフェメラルであり、再起動後は保持されません。
