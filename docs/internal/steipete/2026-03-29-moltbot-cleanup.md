---
title: "Legacy Config Cleanup"
summary: "Remove stale alternate config references, delete obsolete compatibility paths, and rename leftover legacy runtime/test identifiers"
author: "Peter Steinberger <steipete@gmail.com>"
github_username: "steipete"
created: "2026-03-29"
status: "in_progress"
read_when:
  - "Cleaning up legacy config path handling or old rebrand compatibility shims"
---

Context:

- A stale alternate config file in `~/.openclaw/` was unused.
- Active config resolution already prefers `~/.openclaw/openclaw.json`.
- Remaining legacy references were split across config-path compat, installer probes, legacy service detection, and test/runtime labels.

Plan:

- Delete the stale local alternate config.
- Remove obsolete config/state-dir compatibility from path resolution and doctor preflight.
- Drop old legacy gateway service detection and prompts.
- Rename leftover runtime/test strings to `openclaw` or generic legacy wording.
