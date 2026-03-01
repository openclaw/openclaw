---
summary: "`openclaw health` のCLIリファレンス（RPC経由のGatewayヘルスエンドポイント）"
read_when:
  - 実行中のGatewayのヘルスを素早く確認したい場合
title: "health"
---

# `openclaw health`

実行中のGatewayからヘルス情報を取得します。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注意事項：

- `--verbose` はライブプローブを実行し、複数のアカウントが設定されている場合はアカウントごとのタイミングを表示します。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
