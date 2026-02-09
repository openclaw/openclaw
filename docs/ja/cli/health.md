---
summary: "RPC を介した Gateway（ゲートウェイ）のヘルスエンドポイント向けの `openclaw health` の CLI リファレンス"
read_when:
  - 実行中の Gateway（ゲートウェイ）のヘルスをすばやく確認したい場合
title: "ヘルス"
---

# `openclaw health`

ランニングゲートウェイからヘルスを取得します。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注記:

- `--verbose` はライブプローブを実行し、複数のアカウントが設定されている場合はアカウントごとのタイミングを出力します。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
