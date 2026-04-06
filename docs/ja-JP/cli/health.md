---
read_when:
    - 実行中のGateway ゲートウェイのヘルス状態を素早く確認したい場合
summary: '`openclaw health`のCLIリファレンス（RPC経由のGateway ゲートウェイヘルスエンドポイント）'
title: health
x-i18n:
    generated_at: "2026-04-02T07:33:36Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 82a78a5a97123f7a5736699ae8d793592a736f336c5caced9eba06d14d973fd7
    source_path: cli/health.md
    workflow: 15
---

# `openclaw health`

実行中のGateway ゲートウェイからヘルス情報を取得します。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注意事項：

- `--verbose`はライブプローブを実行し、複数のアカウントが設定されている場合はアカウントごとのタイミングを表示します。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
