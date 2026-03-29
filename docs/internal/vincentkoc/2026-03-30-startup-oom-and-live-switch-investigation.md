---
title: "Live Switch and Startup OOM Investigation"
summary: "Investigation and fixes for 2026.3.28 live model switch regressions and container startup memory regression"
author: "Vincent Koc <vincentkoc@ieee.org>"
github_username: "vincentkoc"
created: "2026-03-30"
status: "implemented"
---

# Summary

- Live-session model switch tracking in `2026.3.28` treated transient run-time model mismatches as persisted session switches.
- Gateway startup warmup in `2026.3.28` could cross provider runtime hooks during boot and amplify memory in containerized environments.

# Fix shape

- Prefer persisted runtime `modelProvider/model` when resolving live-session selection.
- Only track persisted live-session changes for runs that started aligned with the persisted selection.
- Make startup primary-model warmup use static model resolution and skip provider runtime hook loading.
