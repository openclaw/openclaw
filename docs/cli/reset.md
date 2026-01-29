---
summary: "CLI reference for `dna reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
---

# `dna reset`

Reset local config/state (keeps the CLI installed).

```bash
dna reset
dna reset --dry-run
dna reset --scope config+creds+sessions --yes --non-interactive
```

