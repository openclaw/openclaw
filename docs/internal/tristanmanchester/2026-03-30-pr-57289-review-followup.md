---
title: "PR 57289 review follow-up"
summary: "Address unresolved review threads for WhatsApp live commentary before updating the PR"
author: "Tristan Manchester <tmanchester96@gmail.com>"
github_username: "tristanmanchester"
created: "2026-03-30"
status: "in_progress"
last_updated: "2026-03-30"
---

Review follow-up for PR #57289 focused on three concrete fixes:

- Scope camelCase directive alias normalization to the WhatsApp commentary delivery path instead of enabling it for every channel by default.
- Deduplicate and merge repeated assistant text blocks that reuse the same `textSignature` id so later fragments are not dropped.
- Remove the duplicated `15_000` commentary timeout fallback by exporting one shared constant for both the WhatsApp caller and the runner wait loop.
- Preserve `assistantTexts` fallback when all finalized assistant outputs were commentary already delivered live.
- Track delivered commentary text per segment so later updates can send only the appended suffix instead of dropping the tail.
- Re-throw `AbortError` from later WhatsApp media sends so truncated commentary is not marked as delivered.

The remaining unresolved review thread about empty final replies after commentary filtering turned out to be a real regression once `assistantTexts` fallback was skipped, so this follow-up now includes that fix and regression coverage.
