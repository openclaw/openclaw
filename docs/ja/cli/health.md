---
summary: "RPC を介した Gateway（ゲートウェイ）のヘルスエンドポイント向けの `openclaw health` の CLI リファレンス"
read_when:
  - 実行中の Gateway（ゲートウェイ）のヘルスをすばやく確認したい場合
title: "ヘルス"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:11Z
---

# `openclaw health`

実行中の Gateway（ゲートウェイ）からヘルス情報を取得します。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注記:

- `--verbose` はライブプローブを実行し、複数のアカウントが設定されている場合はアカウントごとのタイミングを出力します。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
