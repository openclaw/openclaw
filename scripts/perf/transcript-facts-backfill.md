# Paced transcript-facts backfill owner proof

Run only against a synthetic fixture. The harness executes the production discovery,
transaction batch, and non-resident actor-hydration owners. It does not measure Gateway
worker admission, concurrent foreground traffic, drain, or shutdown; those require the
Gateway proof in addition to this owner run.

All generated state, libraries, and profiles belong on the fixture volume. Keep the
normal `TMPDIR`. A ten-million-row hybrid fixture uses full-size payloads on its four
long paths and compact payloads elsewhere. It allocates and deletes ordinary SQLite
rows to fragment overflow chains. By default only `synthetic-0` has finalized identities
and a session header. `--finalize-long-sessions` prepares all four long paths with
headers, unique IDs and parents, and alternating valid user/assistant messages.
Their IDs are recorded in the fixture report; select one with `--session synthetic-2`
for the 49,000-event path. Other paths supply storage and index cardinality.

```sh
mkdir -p .local/facts-backfill
python3 scripts/perf/transcript-active-facts.py \
  --output .local/facts-backfill --schema src/state/openclaw-agent-schema.sql \
  --name ten-million --rows 10000000 --mode hybrid --schema-version 41 \
  --longest-session-rows 49000 --finalize-long-sessions
clang -O2 -Wall -Wextra -Werror -dynamiclib -I/opt/homebrew/opt/sqlite/include \
  scripts/perf/transcript-active-facts-vfs.c -o .local/facts-backfill/bufprobe.dylib
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill.ts \
  --output .local/facts-backfill --name ten-million --label paced --pause-ms 250
```

On Linux build the VFS library with `-shared -fPIC` and the local SQLite headers,
using `bufprobe.so`. The library's counts are logical VFS I/O, including repeated
short overflow-pointer reads. On macOS it also reports process disk I/O charged by
`proc_pid_rusage`; cache hits have no physical reads. Linux physical byte counters
are not currently collected. Both platforms use a 2 MiB SQLite cache and release it
before every measured operation. The harness does not evict the OS page cache.

Use a unique `--label` for each arm. `--max-batches N` stops after N committed batches;
a second invocation starts discovery and its session cursor from scratch, so completed
facts remain covered without a persisted cursor. The default zero means finish the
selected session. `--pause-ms` controls proof pacing only; it is not a runtime option.
`--start-position N` starts at inclusive active position N, useful for preparing
only the last512 rows through the real batch owner before taking a pristine
snapshot. For the49k path use `--start-position 48488 --pause-ms 0
--skip-hydration --allocation-iterations 0`. Preparation is not a measurement.
`--duty-ratio 20` delays by max(pause-ms,20×measured BEGIN-through-COMMIT wall).
This is a native pacing model; the foreground probe separately consumes the
actual host owner’s returned delays, including contention backoff.
`--allocation-iterations 100` collects a separate sampled allocation/CPU pass before
and after, and zero omits that pass. Traced CPU is supporting evidence, not the
untraced timing comparison. Five untraced hydration samples establish medians/spread,
not a p99. Batch percentiles require the sample counts in the lane's decision rules.
`--skip-backfill` runs identical-code before/after hydration controls without changing
coverage. `--skip-hydration` measures only the backfill; use it for the other fixture
sessions that were not finalized for actor hydration.

The normal pacing run retains one native connection. Its repeated non-resident actor
hydrates can reuse the existing exact-version accounting cache; they do not establish
the cold-owner gain. After completing the selected session, run the separate protocol:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill.ts \
  --output .local/facts-backfill --name ten-million --label cold-comparison \
  --compare-hydration --allocation-iterations 100
```

This retains the synthetic facts in memory, alternates empty/full coverage on the
same fixture, and restores all facts in `finally`. It runs four identical-code A/A
pairs, five AB/BA pairs, and two separate allocation AB/BA pairs. Every hydration
opens a fresh native reader, so its connection-owned accounting cache is empty.
Untraced timing excludes reader preparation/close. Sampled allocation and traced CPU
include the complete fresh-reader lifecycle and equality check. All outputs must be
equal. OS page-cache state remains uncontrolled; report physical bytes and retain
the separate warm-connection observations.

Reports include per-batch transaction wall/CPU, rows visited and filled, payload bytes,
VFS and process disk I/O, WAL size, checkpoint health, RSS/heap, host load, and
hydration equality. Initial load above 40 refuses a measured arm. Load during the
arm is retained as context; do not trim individual pauses. Repeat identical-code arms before interpreting an
adverse result. A partial-session or selected-session result is not a complete
10M-row run; any Team completion duration derived from it is an extrapolation.

The final native close timing is not Gateway shutdown latency. Delete the synthetic
SQLite files and sidecars after the campaign; keep the small reports needed by the PR.

## Worker-client lifecycle CPU

`transcript-facts-backfill-client.ts` compares reopening a V2 client for each call
with retaining one client across calls. Both execute the same real backfill command
over one covered tail identity, with admission and module loading warmed first:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill-client.ts \
  --fixture .local/facts-backfill/ten-million.sqlite --session synthetic-2 \
  --after-position 48998 --output .local/facts-backfill --label client-cost
```

The fixture report must identify the selected finalized path. The unmeasured first
call may fill its final fact. A fresh test-state owner supplies isolated config and
cleans up its workers and state. Timing uses one A/A pair and two AB/BA pairs with
1,000 calls per arm; sampled host allocation runs separately. Process CPU includes
Worker threads, while thread CPU and sampled allocation cover the host. The final
open/close-only loop isolates host lifecycle work. This does not claim that each
client open reopens SQLite, or measure payload batch cost or Gateway scheduling.

## Foreground contention

Prepare one synthetic160-session cohort with600 alternating user/assistant messages
per path, then checkpoint the fixture and make a pristine snapshot on the fixture
volume. The helper only accepts synthetic10M fixture metadata under this checkout’s
`.local` directory:

```sh
python3 scripts/perf/transcript-facts-backfill-foreground.py \
  --fixture .local/facts-backfill/ten-million.sqlite \
  --output .local/facts-backfill/cohort-preparation
```

For each arm, make a fresh native filesystem clone (or sequential copy outside the
measurement window) at the same isolated active path. Verify its header, size,
selected index-state rows and historical coverage against the pristine source.
Run one mode per fresh process; join it before removing the owned active copy.
Never remove the pristine source until all arms are complete. The native command is:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-backfill-foreground.ts \
  --fixture .local/facts-backfill/active/ten-million.sqlite \
  --output .local/facts-backfill/results --label arm-0 --modes idle --arm-start 0
```

Predeclare four idle/idle A/A pairs, then idle/backfill/backfill/idle. Each arm
warms160 append/read pairs, waits for host load<=40, and measures1,000 further pairs.
The600-message cohorts are separate from the49k path sampled approximately seven
times per arm. Natural actor epoch changes prove nonresident append/read preimages;
they do not prove OS-cold storage. The background must fill facts during the measured
interval and remain on the49k path. Raw request samples, reservation diagnostics,
returned maintenance delays, host load and actual coverage are retained.

The owner probe drives the actual `runBatch()`/`close()` contract and obeys each
returned delay. It does not prove Gateway readiness/live-run scheduling. For an
explicit slower rate/queue curve, `--pause-multiplier 2` or4 multiplies returned
delays on fresh copies, never shortening the production delay. Report these as
proof-only scheduling settings, not product configuration. If paired signs differ
or baselines differ more than5×, retain all data and use one predeclared extra pair.

The worker-client comparison accepts `--control-pairs 4 --iterations 10000` for
longer untraced controls when the initial short comparison is noisy. Allocation
sampling remains a separate pass.
