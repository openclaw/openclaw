---
summary: "CLI 參考文件：`openclaw logs` (透過 RPC 追蹤 Gateway 記錄)"
read_when:
  - 您需要遠端追蹤 Gateway 記錄 (無需 SSH)
  - 您希望取得 JSON 記錄行以用於工具
title: "記錄"
---

# `openclaw logs`

透過 RPC 追蹤 Gateway 檔案記錄（可在遠端模式下運作）。

相關內容：

-   記錄總覽：[記錄](/logging)

## 範例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

使用 `--local-time` 以在您的當地時區呈現時間戳記。
