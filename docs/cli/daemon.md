---
summary: "CLI reference for `clawdbot daemon` (install/uninstall/status for the Gateway service)"
read_when:
  - You want to run the Gateway as a background service
  - You’re debugging daemon install, status, or logs
---

# `clawdbot daemon`

Manage the Gateway daemon (background service).

Related:
- Gateway CLI: [Gateway](/cli/gateway)
- macOS platform notes: [macOS](/platforms/macos)

Tip: run `clawdbot daemon --help` for platform-specific flags.

Notes:
- `daemon status` supports `--json` for scripting.
- `daemon install|uninstall|start|stop|restart` support `--json` for scripting (default output stays human-friendly).
