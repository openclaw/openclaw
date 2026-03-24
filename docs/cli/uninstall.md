---
summary: "CLI reference for `evox uninstall` (remove gateway service + local data)"
read_when:
  - You want to remove the gateway service and/or local state
  - You want a dry-run first
title: "uninstall"
---

# `evox uninstall`

Uninstall the gateway service + local data (CLI remains).

```bash
evox backup create
evox uninstall
evox uninstall --all --yes
evox uninstall --dry-run
```

Run `evox backup create` first if you want a restorable snapshot before removing state or workspaces.
