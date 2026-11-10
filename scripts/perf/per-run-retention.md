# Gateway run and idle-session retention

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
before measurement. After the ready file appears, write a positive epoch timestamp
in milliseconds as plain text to the start file. Scheduled `--snapshot-minutes`
captures cannot combine with retention rounds; use `--retention-snapshots` below
for coordinated captures at round boundaries. No Team data or live Gateway is needed.

## New sessions that become idle

To measure growing idle inventory, create new parents instead of reusing the hot
pool. Each parent spawns a kept subagent, runs an intentionally failing Code Mode
cell, then sends short text turns. Both parent and child sessions stay unarchived;
the driver verifies the failed tool result reached the provider and the final
reply reached canonical history.

```sh
node scripts/gateway-heap-rig.mjs --root /absolute/new/idle-state \
  --minutes 120 --sessions 2000 --clients 2 --port 44673 \
  --new-turn-sessions 1000 --turns-per-new-session 3 --turn-interval-ms 1 \
  --retention-round-size 750 --snapshot-minutes none --retention-mode retained \
  --retention-snapshots --idle-minutes 6
```

`--new-turn-sessions` determines the turn count; each parent gets two to five
turns. Checkpoint sizes must cover complete parents. The example adds 1,000
parents and 1,000 children to the seeded inventory, with checkpoints every 250
completed parents. It fails if any parent changes physical identity between
turns, a child/failure is missing, or a session was archived/deleted.

`--retention-snapshots` writes full main-isolate snapshots at the same paused
checkpoints, including quiet checkpoints. Use `scripts/heap-snapshot-diff.mjs`
to identify strong owners and dominator bytes. These captures add substantial
CPU, memory and disk cost; compare identical capture settings in A/A arms and
use a separate timing arm for latency. Sampled allocation ancestry alone does
not establish ownership. The preload also reports existing prepared-plugin
lifetime/retirement counts and referenced Node resource counts; `null` means
the owner has not loaded. Ordinary Code Mode execution errors do not imply
plugin cleanup failures.

Growing durable inventory can legitimately retain current metadata and bounded
continuation baselines. Report bytes per newly idle session separately from old
request graphs, and cross existing count/byte/idle limits before calling a cache
unbounded. Six quiet minutes cover five-minute WebSocket expiry, not the HTTP
continuation owner's longer idle window.

Pass `--fixture-gib 35` to generate a 5,000-session synthetic database at its final
state path before Gateway startup. The existing team-shape generator creates one
agent with no retained runs, approvals, cron jobs, projects or local placements;
the completion owner appends real tool-call/result events until the main agent
database reaches the requested physical size. Native owners create the matching
shared state and local credential companion, then verify and close the databases.
The rig retains its own config, external RPC clients and workspaces. No operator
state, copied database identities, padding tables or schema changes are involved.

`--fixture-gib 0` skips large transcript completion and generates the same 5,000
sessions with 64 MiB of logical transcript data for a small setup smoke. The option
accepts nonnegative integers; omitting it preserves ordinary fresh-state seeding.
Generation requires an absent state directory and finishes before the measured
Gateway workload. Allow enough disk space for database files, WAL and verification.

`--sessions` remains the additional RPC-seeded population. The `fixture-seeded`
event records fixture session count, actual database sizes and native verification;
the initial inventory must include both populations. A successful small smoke
qualifies setup only; actual database sizes qualify the large-database experiment.
Populate the new workspace before measurement using the ready/start gate. Database
generation does not establish the 62,000-file workspace shape or filesystem parity.

Analyze synthetic snapshots with `scripts/perf/idle-session-retention-owners.mjs`.
It reports source-qualified owner counts, exact unions of individually dominated
subtrees, and reviewed retaining paths. Different owners share objects, so their
byte totals must not be added. A group union is not a prediction of memory freed
by jointly closing all its objects; use the before/after release experiment for that.
