---
summary: "CLI reference for `EasyHub reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `EasyHub reset`

Reset local config/state (keeps the CLI installed).

```bash
EasyHub reset
EasyHub reset --dry-run
EasyHub reset --scope config+creds+sessions --yes --non-interactive
```
