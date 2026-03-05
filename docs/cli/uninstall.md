---
summary: "CLI reference for `openclaw uninstall` (remove gateway service + local data)"
read_when:
  - You want to remove the gateway service and/or local state
  - You want a dry-run first
title: "uninstall"
---

# `openclaw uninstall`

Uninstall the gateway service + local data (CLI remains).

```bash
openclaw uninstall
openclaw uninstall --all --yes
openclaw uninstall --zap --yes --non-interactive
openclaw uninstall --dry-run
```

- `--all`: remove service + state + workspace + app.
- `--zap`: includes `--all` and also attempts to remove global CLI installs plus OpenClaw shell completion traces.
