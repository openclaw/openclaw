---
summary: "CLI reference for `openclaw reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `openclaw reset`

Reset local config/state (keeps the CLI installed).

```bash
openclaw backup create
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```

Run `openclaw backup create` first if you want a restorable snapshot before removing local state. Note: `openclaw reset` will delete `~/.openclaw/operator1.db`, which contains session history, project bindings, and agent scopes. Back it up with `openclaw backup create` before proceeding.
