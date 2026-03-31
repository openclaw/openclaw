---
name: openclaw-test-heap-leaks
description: Investigate `pnpm test` memory growth, Vitest worker OOMs, and suspicious RSS increases in OpenClaw using the `scripts/test-parallel.mjs` heap snapshot tooling. Use when Codex needs to reproduce test-lane memory growth, collect repeated `.heapsnapshot` files, compare snapshots from the same worker PID, distinguish transformed-module retention from real data leaks, and fix or reduce the impact by patching cleanup logic or isolating hotspot tests.
---

# OpenClaw Test Heap Leaks

Use this skill for test-memory investigations. Do not guess from RSS alone when heap snapshots are available.

## Workflow

1. Reproduce the failing shape first.
   - Match the real entrypoint if possible. For Linux CI-style unit failures, start with:
   - `pnpm canvas:a2ui:bundle && OPENCLAW_TEST_MEMORY_TRACE=1 OPENCLAW_TEST_HEAPSNAPSHOT_INTERVAL_MS=60000 OPENCLAW_TEST_HEAPSNAPSHOT_DIR=.tmp/heapsnap OPENCLAW_TEST_WORKERS=2 OPENCLAW_TEST_MAX_OLD_SPACE_SIZE_MB=6144 pnpm test`
   - Keep `OPENCLAW_TEST_MEMORY_TRACE=1` enabled so the wrapper prints per-file RSS summaries alongside the snapshots.
   - If the report is about a specific shard or worker budget, preserve that shape.

2. Wait for repeated snapshots before concluding anything.
   - Take at least two intervals from the same lane.
   - Compare snapshots from the same PID inside one lane directory such as `.tmp/heapsnap/unit-fast/`.
   - Use `scripts/heapsnapshot-delta.mjs` to compare either two files directly or the earliest/latest pair per PID in one lane directory.

3. Classify the growth before choosing a fix.
   - If growth is dominated by Vite/Vitest transformed source strings, `Module`, `system / Context`, bytecode, descriptor arrays, or property maps, treat it as retained module graph growth in long-lived workers.
   - If growth is dominated by app objects, caches, buffers, server handles, timers, mock state, sqlite state, or similar runtime objects, treat it as a likely cleanup or lifecycle leak.

4. Fix the right layer.
   - For retained transformed-module growth in shared workers:
   - Move hotspot files out of `unit-fast` by updating `test/fixtures/test-parallel.behavior.json`.
   - Prefer `singletonIsolated` for files that are safe alone but inflate shared worker heaps.
   - If the file should already have been peeled out by timings but is absent from `test/fixtures/test-timings.unit.json`, call that out explicitly. Missing timings are a scheduling blind spot.
   - For real leaks:
   - Patch the implicated test or runtime cleanup path.
   - Look for missing `afterEach`/`afterAll`, module-reset gaps, retained global state, unreleased DB handles, or listeners/timers that survive the file.

5. Verify with the most direct proof.
   - Re-run the targeted lane or file with heap snapshots enabled if the suite still finishes in reasonable time.
   - If snapshot overhead pushes tests over Vitest timeouts, fall back to the same lane without snapshots and confirm the RSS trend or OOM is reduced.
   - For wrapper-only changes, at minimum verify the expected lanes start and the snapshot files are written.

## Heuristics

- Do not call everything a leak. In this repo, large `unit-fast` growth can be a worker-lifetime problem rather than an application object leak.
- `scripts/test-parallel.mjs` and `scripts/test-parallel-memory.mjs` are the primary control points for wrapper diagnostics.
- The lane names printed by `[test-parallel] start ...` and `[test-parallel][mem] summary ...` tell you where to focus.
- When one or two files account for most of the delta and they are missing from timings, reducing impact by isolating them is usually the first pragmatic fix.
- When the same retained object families grow across multiple intervals in the same worker PID, trust the snapshots over intuition.

## Snapshot Comparison

- Direct comparison:
  - `node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs before.heapsnapshot after.heapsnapshot`
- Auto-select earliest/latest snapshots per PID within one lane:
  - `node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs --lane-dir .tmp/heapsnap/unit-fast`
- Useful flags:
  - `--top 40`
  - `--min-kb 32`
  - `--pid 16133`

Read the top positive deltas first. Large positive growth in module-transform artifacts suggests lane isolation; large positive growth in runtime objects suggests a real leak.

## Output Expectations

When using this skill, report:

- The exact reproduce command.
- Which lane and PID were compared.
- The dominant retained object families from the snapshot delta.
- Whether the issue is a real leak or shared-worker retained module growth.
- The concrete fix or impact-reduction patch.
- What you verified, and what snapshot overhead prevented you from verifying.
