---
title: "PR 57341 memory session index follow-up"
summary: "Maintainer follow-up for the memory session indexer PR to tighten transcript matching and add focused coverage."
author: "Vincent Koc"
github_username: "vincentkoc"
created: "2026-03-30T00:37:48Z"
---

PR `#57341` found a real regression but the first fix shape was too broad.

Maintainer follow-up:

- reuse `isUsageCountedSessionTranscriptFileName` from the shared session artifact classifier
- include primary, reset, and deleted transcripts
- exclude `.jsonl.bak.*` compaction backups and `.lock` files
- add focused tests for `listSessionFilesForAgent`

Why:

- memory search should see archive variants that still represent real transcript history
- it should not duplicate stale backup snapshots created during compaction
