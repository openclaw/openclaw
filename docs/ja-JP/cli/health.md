---
x-i18n:
  generated_at: "2026-03-04T06:16:36Z"
  model: claude-opus-4-6
  provider: anthropic
  source_hash: 82a78a5a97123f7a5736699ae8d793592a736f336c5caced9eba06d14d973fd7
  source_path: cli/health.md
  workflow: 15
summary: "`openclaw health`（RPC経由のゲートウェイヘルスエンドポイント）のCLIリファレンス"
read_when:
  - 実行中のゲートウェイのヘルスを素早く確認したい場合
title: "health"
---

# `openclaw health`

実行中のゲートウェイからヘルス情報を取得します。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注意事項：

- `--verbose` はライブプローブを実行し、複数のアカウントが設定されている場合はアカウントごとのタイミングを表示します。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
