---
summary: "CLI reference for `activi reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `activi reset`

Reset local config/state (keeps the CLI installed).

```bash
activi reset
activi reset --dry-run
activi reset --scope config+creds+sessions --yes --non-interactive
```
