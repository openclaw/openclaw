---
read_when:
    - CLIをインストールしたままローカル状態を消去したい場合
    - 何が削除されるかドライランで確認したい場合
summary: '`openclaw reset`（ローカル状態/設定のリセット）のCLIリファレンス'
title: reset
x-i18n:
    generated_at: "2026-04-02T07:35:42Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 76e808ce44da49603504aacf92e67ea4af427f0ed9081684b24fb7d3f3922cd5
    source_path: cli/reset.md
    workflow: 15
---

# `openclaw reset`

ローカルの設定/状態をリセットします（CLIはインストールされたまま維持されます）。

```bash
openclaw backup create
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```

ローカル状態を削除する前に復元可能なスナップショットを作成したい場合は、まず `openclaw backup create` を実行してください。
