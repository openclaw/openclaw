---
summary: CLI reference for `openclaw health` (gateway health endpoint via RPC)
read_when:
  - You want to quickly check the running Gateway’s health
title: health
---

# `openclaw health`

從正在執行的 Gateway 獲取健康狀態。

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notes:

- `--verbose` 執行即時探測並在設定多個帳戶時列印每個帳戶的時間。
- 當設定多個代理時，輸出包括每個代理的會話存儲。
