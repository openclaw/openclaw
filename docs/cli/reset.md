---
summary: "CLI reference for `smart-agent-neo reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `smart-agent-neo reset`

Reset local config/state (keeps the CLI installed).

```bash
smart-agent-neo reset
smart-agent-neo reset --dry-run
smart-agent-neo reset --scope config+creds+sessions --yes --non-interactive
```
