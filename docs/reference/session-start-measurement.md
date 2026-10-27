---
summary: "Measure session-start ACK, subscriber-visible text, and tool-start latency on a synthetic busy Gateway"
title: "Session-start measurement"
read_when:
  - Measuring session-start or first-token latency
---

Use the existing `scripts/perf/turn-start-phases.ts` harness against a built
Gateway. It creates isolated synthetic state with 10,800 sessions, 128 MiB of
transcripts plus four 2,000-entry histories, 40 plugins, 65 WebSocket clients,
eight exact session subscribers, four concurrent turns, and sidebar/list/search
and history churn. New foreground sessions start empty; the long histories belong
to retained sessions read by the background clients.

```sh
node --import ./scripts/tsx.mjs scripts/perf/turn-start-phases.ts \
  --entry /path/to/built-revision/dist/entry.js \
  --output .local/session-start-host --port 41920

node --import ./scripts/tsx.mjs scripts/perf/turn-start-phases.ts \
  --entry /path/to/built-revision/dist/entry.js \
  --output .local/session-start-sandbox --port 41930 \
  --sandbox-image openclaw-sandbox:bookworm-slim
```

The sandbox command requires Docker and an already-built sandbox image. Both
commands launch and stop their own loopback Gateway and mock provider. They never
connect to a running operator Gateway. Each output directory must be new.

Fixtures default to the current clock. For a comparison, capture one fresh
epoch-millisecond timestamp and pass it to both arms with `--now <epoch-ms>`.
An old clock can expire the seeded 24-hour collector cohort before measurement,
causing cleanup traffic and changing the workload. Normal maintenance stays enabled.

Fresh turns use the Control UI's `sessions.create({message, worktree: true})`
flow: the Gateway dispatches the initial `chat.send` internally. Its response is
the session creation and initial-turn ACK; the harness does not send the message
twice. Warm turns call `chat.send` on those sessions. The mock waits 200 ms for
each response, streams an assistant preamble, executes real read/exec tools, and
streams its final answer. A fast turn does not wait for other mock requests.

`summary.json` contains `sessionStart.milestones` with count, p50, p90, p95, and
maximum milliseconds, split into fresh and warm cohorts. Defaults are ten rounds
of four turns per cohort; `--cold-rounds` and `--warm-rounds` change the sample
counts. `sessionStart.waterfalls` retains each run's session key, run ID, start
time, admission method, and ordered client milestones:

- Admission begins and its ACK arrives.
- The mock receives the first provider request.
- A separate exact subscriber receives the first nonempty assistant text delta
  or canonical streamed preamble update (commentary uses `agent` item events).
- That subscriber receives the first tool execution start.
- The sender receives successful `agent.wait` completion.

Text and tool receipts can precede the ACK, and the subscriber socket can drain
after `agent.wait`. Neither ordering is treated as a failure. Missing receipts
fail the run rather than silently shrinking the sample count. These measurements
include mock latency and transport delivery, but not browser rendering.

`sessionStart.phases` summarizes the existing `diagnostics.scope` names, such as
`chat.send.preparation` and `chat.send.detail.admission.revalidate`.
These are **overlapping stage duration totals**, not ordered per-turn spans:
the production diagnostics do not carry a run ID, and their timestamps describe
the enclosing request/startup stage. They are attributed only to the concurrent
round/cohort. Do not add their durations or use their timestamps to invent a
per-run critical path. The raw diagnostic events remain in the probe's
`turn-start-phases.json` alongside the client receipts.

Run baseline and candidate builds with the same tooling checkout, options,
sandbox mode, and fresh fixtures; counterbalance their order. `identity.json`
records the entry/runtime hashes, build metadata, tooling revision, and workload; `summary.json` records host
load before and after. Fresh rounds have a 31-second gap and advance the synthetic
Git origin to exercise base refresh; `--unchanged-origin` keeps it fixed. Use
`--cpu-profile` or `--git-trace` in a separate diagnostic pass. Small-sample tails
are descriptive; use matched A/A controls before attributing adverse changes to
a candidate. Whole-Gateway CPU/allocation/GC stress remains owned by
`scripts/perf/team-shape-stress.ts`.
