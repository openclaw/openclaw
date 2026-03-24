---
summary: "CLI reference for `evox reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `evox reset`

Reset local config/state (keeps the CLI installed).

```bash
evox backup create
evox reset
evox reset --dry-run
evox reset --scope config+creds+sessions --yes --non-interactive
```

Run `evox backup create` first if you want a restorable snapshot before removing local state.
