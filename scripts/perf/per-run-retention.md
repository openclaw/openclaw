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

## Completion-custody owner cost

Use `scripts/perf/subagent-custody-settlement.mjs` for a supplementary measurement
of the actual registry settlement method, separate from the Gateway workload:

```sh
node --expose-gc --import ./scripts/tsx.mjs \
  /absolute/candidate/scripts/perf/subagent-custody-settlement.mjs \
  "$PWD" "$PWD/.local/custody-timing-a1"
```

Run from each pinned source checkout with an absent output directory and the same
Node executable. The script sets synthetic state/config paths before importing
the owner. Each process discards two warm trials, then measures 20 fresh trials of
1,000 kept, non-announcing child acknowledgements. It admits ten rows outside each
timed interval, settles their changed run IDs individually, and reports four
250-run rounds. Setup, GC and final teardown are excluded. Check the reported
unreleased counts and preserved historical rows before interpreting timings.

Use separate fresh processes in A0/A1/B1/A2/B2/A3/B3/A4/B4/A5/B5 order; A0 is an
adjacent unchanged control. Pool each process into one observation, not 20
independent samples. Record median, p95, spread and host load. Declare acceptable
control and paired regressions before running; stop and investigate failed gates.

Add `allocation` as the final argument for a separate inspector-sampled run with
collected objects included. Only ancestry under `settleCompletionAuthorities`
counts as owner allocation; the total also includes fixture construction. A missing
owner frame is unmeasured, not zero. Traced timing is diagnostic, and allocation
results require separate controls. The script preserves the raw sample tree.

This benchmark includes the real owner scan, alias lookup, Map deletion and abort
listener removal, with tiny synthetic authority-release callbacks. It excludes
database commits and full operator/source teardown, so it cannot establish Gateway
latency. A correct release can allocate temporarily while reducing retained memory;
report that tradeoff rather than treating allocation and retention as equivalent.

## Sandbox preparation

Add `--sandbox-image <existing-local-image>` to the fixed-session workload to
prepare real Docker sandboxes. Each agent workspace contains 135 synthetic skills
with eight supporting files each. Use 50 fixed sessions and 150 turns to compare
first preparation with two reuse passes; force GC every 25 turns and include a
quiet checkpoint. The Gateway runs the normal agent/Responses flow. The synthetic
provider does not execute container tools.

Add `--sandbox-worktrees` to create each active session through the real managed
worktree RPC before its first turn. This commits the synthetic source repositories
and asserts the returned worktree identities. Managed fixtures and `--fixture-gib
35` fixtures contain 62,000 additional files totaling 1.116 GB across the two
agent workspaces. The database-size option remains independent: only
`--fixture-gib 35` establishes the large database population. Report filesystem
and backend differences; Docker/APFS does not prove Podman/Btrfs behavior.

The rig leaves task containers and synthetic state for inspection. After its
Gateway exits, remove only the containers belonging to that run's
`heap-rig-<port>-` prefix, then remove its state when analysis is complete.
Use a safe host temporary directory; the state/output volume may have shared
ancestors that are unsuitable for temporary credential files.

For the separate browser HTTP listener owner, run:

```sh
node --expose-gc --import ./scripts/tsx.mjs \
  scripts/perf/sandbox-browser-context-retention.ts --count 50 --measure timing
```

The real authenticated bridge serves HTTP while synthetic preparation scopes
become unreachable. Each scope contains a labeled 1 MiB array; the measured
bytes are a scaled ownership test, not production bytes per sandbox. Select a
frozen listener with `--owner <file>` for baseline/candidate pairs, and run
`--measure allocation` separately. This does not launch Chromium or exercise
sandbox provisioning. Explicit capability callbacks have their own lifetimes;
the test isolates implicit async-context retention by the listener.
