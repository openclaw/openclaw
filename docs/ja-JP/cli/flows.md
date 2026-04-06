---
read_when:
    - 古いリリースノート、Issueスレッド、または検索結果で openclaw flows に遭遇した場合
    - openclaw flows の代わりになったコマンドを知りたい場合
summary: 誤ってドキュメント化された `openclaw flows` コマンドに関する互換性の注意
title: flows
x-i18n:
    generated_at: "2026-04-02T07:33:33Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 438920498b0a51aadbd3abaed98f821fa1483066ac42ed7ec3fe9e346ac8e5d3
    source_path: cli/flows.md
    workflow: 15
---

# `openclaw flows`

`openclaw flows` は現在の OpenClaw CLI コマンドでは**ありません**。

一部の古いリリースノートやドキュメントで、誤って `flows` コマンドサーフェスが記載されていました。サポートされているオペレーターサーフェスは [`openclaw tasks`](/automation/tasks) です。

```bash
openclaw tasks list
openclaw tasks show <lookup>
openclaw tasks cancel <lookup>
```

## 代わりに使用するコマンド

- `openclaw tasks list` — 追跡中のバックグラウンドタスクを一覧表示
- `openclaw tasks show <lookup>` — タスクID、実行ID、またはセッションキーで1つのタスクを確認
- `openclaw tasks cancel <lookup>` — 実行中のバックグラウンドタスクをキャンセル
- `openclaw tasks notify <lookup> <policy>` — タスクの通知動作を変更
- `openclaw tasks audit` — 古くなったまたは壊れたタスク実行を表示

## このページが存在する理由

このページは、古い変更履歴エントリ、Issueスレッド、検索結果からの既存リンクがデッドエンドではなく明確な修正先を持てるように残されています。

## 関連

- [バックグラウンドタスク](/automation/tasks) — 分離されたワークレジャー
- [CLI リファレンス](/cli/index) — 完全なコマンドツリー
