---
summary: CLI reference for `openclaw reset` (reset local state/config)
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: reset
---

# `openclaw reset`

重置本地設定/狀態（保留已安裝的 CLI）。

```bash
openclaw backup create
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```

如果想在移除本地狀態前先建立可還原的快照，請先執行 `openclaw backup create`。
