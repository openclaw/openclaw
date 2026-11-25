# Completed-run retention

Use `transcript-broadcast-measure.ts --stress-network-tool` with `--stress-tools`
to execute a real loopback HTTP request inside each Code Mode cell. The synthetic
plugin creates the tool through its normal per-run factory. Its `fetch` uses the
Gateway's ordinary HTTP transport, so sockets and keep-alive timers are created
inside the tool invocation. The tool verifies the response body, and each round
requires exactly one HTTP request per completed cell. The fixture does not retain
tool objects or create artificial long-lived timers.

Build each source revision with `pnpm build sourcePerformance`. This supplies
runtime package artifacts, bundled plugin assets, and build identity without the
UI or declaration build. Keep `dist` and workspace package artifacts fixed while
that revision's Gateway is running. Sequential baseline and candidate runs can
reuse one checkout: finish baseline captures before rebuilding the candidate.
Record both source SHAs and `dist/build-info.json` with the results.

For each revision, prepare fresh identical fixtures for N and 2N completed turns:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
  --fixture-only --output "$PWD/.local/run-retention/base-n" \
  --sessions 10800 --transcript-mib 16 --port 41760
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir "$PWD/.local/run-retention/base-n" --entry "$PWD/dist/entry.js" \
  --scenario memory-soak --team-stress --mixed-rpc \
  --stress-tools --stress-tool-search --stress-network-tool \
  --clients 65 --exact-clients 64 --runs 4 --plugins 40 \
  --soak-rounds 10 --duration-ms 1 --warmup-ms 0 --round-interval-ms 1 \
  --list-interval-ms 25000 --retained-profile-ms 0 \
  --reset-every-rounds 0 --chunks 2 --chunk-interval-ms 1 --prompt-kib 8 \
  --worker-memory --diagnostics --heap-snapshot --port 41760 --mock-port 41762
```

Repeat with a fresh `base-2n` fixture, different free ports, and `--soak-rounds 20`.
After rebuilding, repeat as `candidate-n` and `candidate-2n`. These execute 40 and
80 measured foreground turns. The harness also runs one warmup cohort even when
`--warmup-ms 0`; startup and cron turns are additional, separately reported work.
The network fixture adds one external synthetic plugin to the 40 bundled plugins.

Omit `--poll-seed` for these short fixed-work cohorts: deterministic initial
polls cover every RPC method before a cohort ends. Random phases spread across
25 seconds can miss methods and correctly fail the harness coverage guard.

The fixed-work runs finish when their declared rounds finish; `--duration-ms 1`
does not truncate them. They are retention diagnostics, not ten-minute latency
acceptance evidence. To pace the same counts across ten minutes, use
`--duration-ms 600000` with `--round-interval-ms 60000` for N and `30000` for 2N.
Use the canonical `team-shape-stress.ts` campaign for matched AB/BA timing and
allocation evidence when whole-Gateway acceptance requires it.

Each result directory contains `result.json`, post-work forced-GC samples in
`memory-samples.jsonl`, and `settled.heapsnapshot`. Compare post-GC heap and counts
of reachable tool metadata keys, attempt continuations, and AsyncContextFrame
retainer paths at N and 2N:

```sh
python3 scripts/perf/run-tool-retention-counts.py /path/to/settled.heapsnapshot
```

The analyzer emits only source-reviewed labels and aggregates. It loads the full
snapshot JSON, so allow several times its file size in memory. Exclude WeakMap ephemeron value edges when attributing
why tool keys remain reachable. Follow `heap-retention-runbook.md` for local
aggregate-only snapshot analysis; raw snapshots are not PR attachments.

A reused HTTP pool may bound retained contexts at its connection count. Do not
claim linear completed-run growth unless N/2N captures actually show it. Report
live-owner counts and retainer paths alongside total heap so legitimate retained
session history cannot be mistaken for run-scoped tool retention.
