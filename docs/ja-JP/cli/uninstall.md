---
read_when:
    - Gateway ゲートウェイサービスやローカル状態を削除したいとき
    - 先にドライランを実行したいとき
summary: '`openclaw uninstall` の CLI リファレンス（Gateway ゲートウェイサービスとローカルデータの削除）'
title: uninstall
x-i18n:
    generated_at: "2026-04-02T07:36:00Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5a82cdcb2a7254f87edd3c6678e4c35f00c805971c705610149cbb2ff48b29a4
    source_path: cli/uninstall.md
    workflow: 15
---

# `openclaw uninstall`

Gateway ゲートウェイサービスとローカルデータをアンインストールします（CLI は残ります）。

```bash
openclaw backup create
openclaw uninstall
openclaw uninstall --all --yes
openclaw uninstall --dry-run
```

状態やワークスペースを削除する前に復元可能なスナップショットが必要な場合は、先に `openclaw backup create` を実行してください。
