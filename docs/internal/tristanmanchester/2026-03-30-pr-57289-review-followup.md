---
title: "PR 57289 review follow-up"
summary: "Address unresolved review threads for WhatsApp live commentary before updating the PR"
author: "Tristan Manchester <tmanchester96@gmail.com>"
github_username: "tristanmanchester"
created: "2026-03-30"
status: "in_progress"
---

Review follow-up for PR #57289 focused on three concrete fixes:

- Scope camelCase directive alias normalization to the WhatsApp commentary delivery path instead of enabling it for every channel by default.
- Deduplicate and merge repeated assistant text blocks that reuse the same `textSignature` id so later fragments are not dropped.
- Remove the duplicated `15_000` commentary timeout fallback by exporting one shared constant for both the WhatsApp caller and the runner wait loop.

One remaining review thread on empty final replies after commentary filtering looks intentional rather than a clear regression, so leave that open unless validation shows a real user-facing failure.
