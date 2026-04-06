---
read_when:
    - 古いリリースノートやドキュメントで ClawFlow や openclaw flows に遭遇した場合
    - ClawFlow の用語が現在の CLI でどのように対応するか理解したい場合
    - 古い flow 参照を現在サポートされている task コマンドに変換したい場合
summary: リリースノートやドキュメントにおける古い ClawFlow 参照に関する互換性メモ
title: ClawFlow
x-i18n:
    generated_at: "2026-04-02T07:29:51Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4b5b0250f5c218ee753a26900711a948504df360e420f89c8582670a039d8b7c
    source_path: automation/clawflow.md
    workflow: 15
---

# ClawFlow

`ClawFlow` は、一部の古い OpenClaw リリースノートやドキュメントにおいて、独自の `openclaw flows` コマンド体系を持つユーザー向けランタイムであるかのように記載されています。

これは、このリポジトリにおける現在のオペレーター向けインターフェースではありません。

現在、切り離された作業の確認・管理にサポートされている CLI インターフェースは [`openclaw tasks`](/automation/tasks) です。

## 現在使用すべきコマンド

- `openclaw tasks list` は追跡中の切り離された実行を表示します
- `openclaw tasks show <lookup>` はタスク ID、実行 ID、またはセッションキーで1つのタスクを表示します
- `openclaw tasks cancel <lookup>` は実行中のタスクをキャンセルします
- `openclaw tasks audit` は古くなった、または壊れたタスク実行を表示します

```bash
openclaw tasks list
openclaw tasks show <lookup>
openclaw tasks cancel <lookup>
```

## 古い参照に対する対応

以下の場所で `ClawFlow` や `openclaw flows` を見かけた場合：

- 古いリリースノート
- Issue スレッド
- 古くなった検索結果
- 更新されていないローカルメモ

それらの指示を現在の task CLI に読み替えてください：

- `openclaw flows list` -> `openclaw tasks list`
- `openclaw flows show <lookup>` -> `openclaw tasks show <lookup>`
- `openclaw flows cancel <lookup>` -> `openclaw tasks cancel <lookup>`

## 関連

- [バックグラウンドタスク](/automation/tasks) — 切り離された作業の台帳
- [CLI: flows](/cli/flows) — 誤ったコマンド名に関する互換性メモ
- [Cron ジョブ](/automation/cron-jobs) — タスクを作成する可能性のあるスケジュールジョブ
