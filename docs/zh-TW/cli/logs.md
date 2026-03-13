---
summary: CLI reference for `openclaw logs` (tail gateway logs via RPC)
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: logs
---

# `openclaw logs`

透過 RPC 追蹤 Gateway 檔案日誌（適用於遠端模式）。

相關資訊：

- 日誌總覽：[Logging](/logging)

## 範例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

使用 `--local-time` 來以您當地的時區呈現時間戳記。
