# Fixed-session Gateway retention

Run the built Gateway with its real chat, agent and OpenAI Responses transport,
using a local synthetic provider and new isolated state directory:

```sh
node scripts/gateway-heap-rig.mjs --root /absolute/new/synthetic-state \
  --minutes 15 --sessions 2000 --clients 2 --port 44673 \
  --fixed-turn-sessions 8 --turn-count 80 --turn-interval-ms 1 \
  --retention-round-size 10 --snapshot-minutes none --short-replies \
  --retention-mode retained
```

The fixed pool reuses seeded physical session IDs and fails on replacement. Other
seeded sessions remain available for the existing client/list workload. Text-only
turns avoid the default driver's deliberate subagent, cron and session churn.
The time limit is a deadline: missing the requested turn count fails the run.

Each completed round pauses client traffic, drains admitted RPCs and asks the
owned Gateway's private IPC preload to force two collections. `result.json` and
`measurements.jsonl` record old-space plus large-object-space used bytes, all heap
spaces, main-thread CPU, elapsed time, host load, completed turns and cumulative
prompt/reply payload bytes. CPU/elapsed exclude checkpoint GC/profile processing.
Canonical histories still grow: short replies reduce that confound but do not
eliminate it. A slope alone does not establish a leak.

Sampling starts after seeding and remains active through all rounds. `retained`
reports allocations made since that baseline and still alive at each checkpoint;
it is not net growth and cannot describe allocations predating the baseline.
`inclusiveBytesByTarget` follows matching function names in each allocation stack;
targets overlap and must not be added. `sites` contains the 100 largest exclusive
allocation sites. Names/lines refer to the built JavaScript. A request allocated
under a comparison does not imply that the comparison owns its lifetime: use a
separate full heap snapshot to find the actual strong retainer before changing
production code.

Repeat with fresh state and `--retention-mode allocation` for cumulative allocation
including collected objects, then `--retention-mode timing` for CPU/wall without
sampling. Timing still forces GC between rounds. Run A/A controls and baseline /
candidate arms serially. Neither sampled profiling nor forced-GC timings are
uninstrumented production latency measurements. The preload only observes the
Gateway main isolate, not workers, and does not import or rewrite production code.

Use `--ready-file` and `--start-file` when preparing a larger synthetic workspace
before measurement. Full snapshots use the existing `--snapshot-minutes` mode in
a separate run; simultaneous snapshots and round profiling are rejected so the
two pause owners cannot overlap. No Team data or live Gateway is needed.
