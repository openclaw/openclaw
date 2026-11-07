# Paced transcript-facts backfill owner proof

Run only against a synthetic fixture. The harness executes the production discovery,
transaction batch, and non-resident actor-hydration owners. It does not measure Gateway
worker admission, concurrent foreground traffic, drain, or shutdown; those require the
Gateway proof in addition to this owner run.

All generated state, libraries, and profiles belong on the fixture volume. Keep the
normal `TMPDIR`. A ten-million-row hybrid fixture uses full-size payloads on its four
long paths and compact payloads elsewhere. It allocates and deletes ordinary SQLite
rows to fragment overflow chains. Only `synthetic-0` has finalized identities and a
session header for hydration; the other paths supply storage and index cardinality.

```sh
mkdir -p .local/facts-backfill
python3 scripts/perf/transcript-active-facts.py \
  --output .local/facts-backfill --schema src/state/openclaw-agent-schema.sql \
  --name ten-million --rows 10000000 --mode hybrid --schema-version 41 \
  --longest-session-rows 49000
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
`--allocation-iterations 100` collects a separate sampled allocation/CPU pass before
and after, and zero omits that pass. Traced CPU is supporting evidence, not the
untraced timing comparison. Five untraced hydration samples establish medians/spread,
not a p99. Batch percentiles require the sample counts in the lane's decision rules.
`--skip-backfill` runs identical-code before/after hydration controls without changing
coverage. `--skip-hydration` measures only the backfill; use it for the other fixture
sessions, whose identities are not finalized for actor hydration.

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
