---
summary: CLI reference for `openclaw logs` (tail gateway logs via RPC)
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: logs
---

# `openclaw logs`

透過 RPC 尾隨 Gateway 檔案日誌（在遠端模式下運作）。

[[BLOCK_1]]

- 日誌概述: [Logging](/logging)

## Examples

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

使用 `--local-time` 來以您的當地時區顯示時間戳記。
