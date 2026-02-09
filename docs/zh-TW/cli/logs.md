---
summary: "「openclaw logs」的 CLI 參考（透過 RPC 追蹤 Gateway 閘道器 記錄）"
read_when:
  - 您需要在不使用 SSH 的情況下，遠端追蹤 Gateway 閘道器 記錄
  - 您需要用於工具整合的 JSON 記錄行
title: "logs"
---

# `openclaw logs`

透過 RPC 追蹤 Gateway 閘道器 檔案記錄（可在遠端模式下運作）。

Related:

- 記錄概覽：[Logging](/logging)

## 範例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
