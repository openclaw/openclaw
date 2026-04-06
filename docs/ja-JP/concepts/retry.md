---
read_when:
    - プロバイダーのリトライ動作やデフォルト値を更新する場合
    - プロバイダーの送信エラーやレート制限をデバッグする場合
summary: 送信プロバイダー呼び出しのリトライポリシー
title: リトライポリシー
x-i18n:
    generated_at: "2026-04-02T07:38:38Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 55bb261ff567f46ce447be9c0ee0c5b5e6d2776287d7662762656c14108dd607
    source_path: concepts/retry.md
    workflow: 15
---

# リトライポリシー

## 目標

- マルチステップフローごとではなく、HTTP リクエストごとにリトライする。
- 現在のステップのみをリトライして順序を保持する。
- 冪等でない操作の重複を避ける。

## デフォルト値

- 試行回数: 3
- 最大遅延上限: 30000 ms
- ジッター: 0.1（10パーセント）
- プロバイダーのデフォルト:
  - Telegram 最小遅延: 400 ms
  - Discord 最小遅延: 500 ms

## 動作

### Discord

- レート制限エラー（HTTP 429）のみでリトライする。
- Discord の `retry_after` が利用可能な場合はそれを使用し、それ以外は指数バックオフ。

### Telegram

- 一時的なエラー（429、タイムアウト、接続/リセット/クローズ、一時的に利用不可）でリトライする。
- `retry_after` が利用可能な場合はそれを使用し、それ以外は指数バックオフ。
- Markdown パースエラーはリトライされず、プレーンテキストにフォールバックする。

## 設定

`~/.openclaw/openclaw.json` でプロバイダーごとにリトライポリシーを設定します:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## 注意事項

- リトライはリクエストごとに適用されます（メッセージ送信、メディアアップロード、リアクション、投票、スタンプ）。
- 複合フローでは完了済みのステップはリトライされません。
