---
summary: "透過 RPC 取得 Gateway 閘道器 健康狀態端點的 `openclaw health` CLI 參考"
read_when:
  - 當你想要快速檢查正在執行的 Gateway 閘道器 健康狀態
title: "health"
---

# `openclaw health`

從正在執行的 Gateway 閘道器 擷取健康狀態。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

注意事項：

- `--verbose` 會執行即時探測，並在設定多個帳號時列印各帳號的耗時。
- Output includes per-agent session stores when multiple agents are configured.
