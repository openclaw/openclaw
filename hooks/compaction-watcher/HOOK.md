---
name: compaction-watcher
description: "Log compaction lifecycle events for session-context diagnostics"
metadata:
  { "openclaw": { "emoji": "🧩", "events": ["session:compact:before", "session:compact:after"] } }
---

# Compaction Watcher

Logs `session:compact:*` events to `~/.openclaw/logs/compaction-events.log` so we can quickly diagnose
context-limit behavior without scanning huge gateway logs.

Each compaction event includes token and summary metadata from the runtime session context.
