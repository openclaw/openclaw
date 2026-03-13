---
summary: CLI reference for `openclaw uninstall` (remove gateway service + local data)
read_when:
  - You want to remove the gateway service and/or local state
  - You want a dry-run first
title: uninstall
---

# `openclaw uninstall`

卸載網關服務 + 本地數據（CLI 保留）。

```bash
openclaw backup create
openclaw uninstall
openclaw uninstall --all --yes
openclaw uninstall --dry-run
```

如果您想在移除狀態或工作區之前獲得可恢復的快照，請先執行 `openclaw backup create`。
