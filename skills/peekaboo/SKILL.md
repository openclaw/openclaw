---
name: peekaboo
description: Capture and automate macOS UI with the Peekaboo CLI.
metadata: {"clawdis":{"requires":{"bins":["peekaboo"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/peekaboo","bins":["peekaboo"],"label":"Install Peekaboo (brew)"}]}}
---

# Peekaboo

Use `peekaboo` to capture, inspect, and interact with macOS UI.

Core commands
- Capture: `peekaboo capture`
- Inspect: `peekaboo see --annotate`
- Click: `peekaboo click --target "..."`
- List windows: `peekaboo list`
- Tool info: `peekaboo tools`
- Permissions: `peekaboo permissions status`

Notes
- Requires Screen Recording + Accessibility permissions.
- Use `peekaboo see --annotate` to identify targets before clicking.
