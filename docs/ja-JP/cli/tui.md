---
read_when:
    - Gateway ゲートウェイ用のターミナルUI（リモート対応）が欲しい場合
    - スクリプトからurl/token/sessionを渡したい場合
summary: '`openclaw tui`（Gateway ゲートウェイに接続するターミナルUI）のCLIリファレンス'
title: tui
x-i18n:
    generated_at: "2026-04-02T07:36:02Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 60e35062c0551f85ce0da604a915b3e1ca2514d00d840afe3b94c529304c2c1a
    source_path: cli/tui.md
    workflow: 15
---

# `openclaw tui`

Gateway ゲートウェイに接続するターミナルUIを開きます。

関連:

- TUIガイド: [TUI](/web/tui)

注意事項:

- `tui` は、可能な場合、トークン/パスワード認証用に設定された Gateway ゲートウェイ認証 SecretRef を解決します（`env`/`file`/`exec` プロバイダー）。
- 設定済みのエージェントワークスペースディレクトリ内から起動した場合、TUI はセッションキーのデフォルトとしてそのエージェントを自動選択します（`--session` が明示的に `agent:<id>:...` と指定されていない場合）。

## 使用例

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# エージェントワークスペース内で実行すると、そのエージェントを自動的に推定します
openclaw tui --session bugfix
```
