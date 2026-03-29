---
title: "Config Runtime Snapshot Pinning"
summary: "Pin first successful config load in memory; rely on explicit reload/watcher paths to swap snapshots instead of reparsing openclaw.json on hot paths."
author: "Peter Steinberger <steipete@gmail.com>"
github_username: "steipete"
created: "2026-03-29"
status: "done"
read_when:
  - "Changing config loading, runtime snapshot, or gateway reload behavior"
---

- Problem: `loadConfig()` still reparsed disk after a short TTL when no runtime snapshot had been set yet.
- Symptom: hot paths like Discord preflight could crash on a transiently malformed `openclaw.json` even after a prior good load.
- Decision: first successful `loadConfig()` becomes the process runtime snapshot.
- Reload model: watcher/reload paths stay responsible for swapping that snapshot atomically.
- Write path: successful `writeConfigFile()` refreshes the in-memory snapshot instead of clearing it.
- Non-goal: broad config-system rewrite. Keep existing reload/watcher path; remove only the repeated disk-read behavior from hot paths.
- Follow-up cleanup:
  - removed the old TTL-based `OPENCLAW_CONFIG_CACHE_MS` / `OPENCLAW_DISABLE_CONFIG_CACHE` path from `src/config/io.ts`
  - added `resetConfigRuntimeState()` so tests stop hand-rolling snapshot resets
  - updated Discord preflight wording to match runtime-snapshot semantics
  - adjusted session-listing subagent selection to prefer active disk-only runs while still honoring newer in-memory replacement rows
  - deleted the flaky duplicated Telegram gateway writeback integration test and kept stable coverage in `server-methods/send.test.ts` plus `extensions/telegram/src/target-writeback.test.ts`
  - trimmed remaining Telegram-specific assertions from `src/gateway/server-methods/send.test.ts` so core only covers generic channel-send contracts and Telegram writeback behavior stays extension-owned
  - removed public SDK re-exports that reached directly into bundled extension source paths; `plugin-sdk/agent-runtime` no longer leaks `sglang`/`vllm`, and `plugin-sdk/xai-model-id` now uses the facade loader instead of `../../extensions/xai/*`
