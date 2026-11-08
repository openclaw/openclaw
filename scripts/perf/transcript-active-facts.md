# Active transcript facts proof

These scripts create synthetic schema-40 agent databases and measure the migration,
hydration readers, and append writers for the initially empty active-facts table.
They never open live data. Use a filesystem with room for the fixture, transient WAL,
and reports; a 70 GB file must not live on a nearly full system volume. Generate one
large fixture at a time. The generator refuses an existing database, including an
unfinished fixture from an earlier run.

The Python generator needs Python 3.14+ with `compression.zstd` and SQLite with
STRICT and FTS5 support. The TypeScript runner uses the checkout's package manager
installation and native SQLite runtime. Compile the small VFS extension against
headers compatible with that runtime; do not link it to a second SQLite library.

## Prepare a pinned predecessor

Run from the candidate repository root. `BASE` must name the exact schema-40 revision
being compared. The runner exports the relevant predecessor modules into its output
directory for the before arm; it does not create another checkout or installation.

```sh
BASE=<40-character-predecessor-commit>
PROOF="$PWD/.local/active-facts"
mkdir -p "$PROOF"
git show "$BASE:src/state/openclaw-agent-schema.sql" > "$PROOF/base-schema.sql"
clang -O2 -Wall -Wextra -dynamiclib -I/opt/homebrew/opt/sqlite/include \
  scripts/perf/transcript-active-facts-vfs.c -o "$PROOF/bufprobe.dylib"
```

On Linux, use `-shared -fPIC` instead of `-dynamiclib`, the installed SQLite header
path, and an output named `bufprobe.so`. The explicit extension entrypoint is
`sqlite3_bufprobe_init`.

## Generate fixtures

```sh
python3 scripts/perf/transcript-active-facts.py \
  --output "$PROOF" --schema "$PROOF/base-schema.sql" \
  --name million --rows 1000000 --mode compact
python3 scripts/perf/transcript-active-facts.py \
  --output "$PROOF" --schema "$PROOF/base-schema.sql" \
  --name ten-million --rows 10000000 --mode compact
python3 scripts/perf/transcript-active-facts.py \
  --output "$PROOF" --schema "$PROOF/base-schema.sql" \
  --name team --rows 6300000 --mode full --file-bytes 70000000000
```

`compact` isolates row-count scaling with small payloads. `full` stores real Zstandard
payloads with a seeded size distribution, interleaves session appends, and frees
alternating one-page ballast records before writing transcripts. Most sessions have
about 245 events; long tails have 20,000, 34,153, 40,000, and 50,000 events. The measured
`synthetic-0` path has a canonical session header and identity at raw sequence zero,
followed by its active events; the header is not an active event.

The optional `--file-bytes` setting raises the high-water mark by inserting actual
SQLite rows and then dropping that temporary table. It does not use sparse-file
padding. The report distinguishes logical file length, filesystem-allocated bytes,
SQLite free pages, and non-free page bytes. Non-free pages include indexes, catalog,
and pointer-map pages; that number is not the transcript payload size. Pool payload
sizes describe the reusable distribution before measured-session finalization.
Only the measured path receives unique hydrated event bodies; sibling sessions
supply storage and index cardinality. Historical custom placement markers remain
outside its measured 512-event suffix: they exercise dependency scanning, not
artifact replay. The first event is ordinary, and smaller fixtures omit markers
that would enter the measured suffix. At 34,153 active events this produces 155
historical markers. Earlier campaign fixtures had 156, including a first marker
with an unavailable source outside the selected suffix. Preserve that distinction
in reports: earlier owner equality/timing results are not measurements of the
corrected generator.

## Measure the owners

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts upgrade \
  --output "$PROOF" --name million --base "$BASE"
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts upgrade \
  --output "$PROOF" --name ten-million --base "$BASE"
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts upgrade \
  --output "$PROOF" --name team --base "$BASE"

node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts read \
  --output "$PROOF" --name team --base "$BASE" --phase empty
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts read \
  --output "$PROOF" --name team --base "$BASE" --phase partial
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts read \
  --output "$PROOF" --name team --base "$BASE" --phase full
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts read \
  --output "$PROOF" --name team --base "$BASE" --phase full \
  --mode allocation --iterations 100

node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts append \
  --output "$PROOF" --base "$BASE" --mode timing --iterations 5000
node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts append \
  --output "$PROOF" --base "$BASE" --mode allocation --iterations 5000

node --import ./scripts/tsx.mjs scripts/perf/transcript-active-facts.ts rollback \
  --output "$PROOF" --name million --base "$BASE"
```

The upgrade probe invokes the existing migration and scoped-backup owners, recording
phase wall/CPU time, read/write bytes, WAL growth, and backup size. It does not substitute
fixture DDL for the actual migration. The rollback probe uses the predecessor reader's
version fence and the scoped restore owner. Run rollback after the reads on that file;
it returns the file to its predecessor schema.

The read phases use no facts, only the latest 512 facts, or the full measured active
path. Timing uses five pairs; `--mode allocation --iterations 100` runs separate
sampling passes through the real actor and bounded-context readers. Timing reports
use `<name>-<phase>-reads-timing.json`, and allocation reports use a separate suffix. Populating facts is synthetic fixture setup, not a proposed migration or reader
backfill. Compare exact owner outputs as well as query counts and costs. The partial
phase exposes the adoption limit: appends can cover a recent window while old dependency
candidates remain uncovered. Natural window coverage takes approximately 512 divided by
the event append rate; no production rate is assumed by the tooling.

Read and append connections enable the existing native Kysely statement cache, matching
the production agent database owner for both revisions. Reports identify this with
`native_statement_cache: true`. Earlier uncached runs are diagnostic only: they include
repeated native statement compilation that production avoids, so keep them separate
from comparisons made with the production connection policy.

Append timing uses five counterbalanced base/candidate pairs and four identical-code
A/A pairs. Allocation sampling is a separate pass. If reusing completed controls after
a setup failure, retain the original reports and record the reason for `--skip-controls`.
Do not discard completed samples or checkpoints because they look slow.

## Interpret the evidence

The VFS wrapper counts all newly opened connections in the process while installed.
A migration phase can include source, scoped backup, and maintenance-state I/O.
`page_reads` counts intersected 4 KiB page spans, including repeated reads and short
overflow-pointer reads. Pager visits are cache hits plus misses. Neither quantity is
physical disk I/O. SQLite page-cache release and disabled mmap leave the operating
system cache uncontrolled; report that limitation beside cold-read timings.

The native wrapper is temporary, process-wide diagnostic instrumentation. Install it
only after maintenance lease and worker initialization, restore the previous default
VFS before owner cleanup, and retain its control connection through the measured work.
It remains loaded for the process lifetime so delayed native closes cannot call unloaded
VFS methods. Use one serial measurement at a time, never a serving Gateway or unrelated
concurrent workloads in the same process.

Report before/after values, absolute differences, sample counts, host load, and the
actual output equality result. Five read samples support means and spread, not p99.
A/A controls determine whether an apparent append regression is distinguishable from
host noise. SQL metrics do not establish whole-Gateway allocation, GC, event-loop tails,
sessions-list latency, or RSS; report those as unmeasured unless separately exercised.

Remove the large synthetic databases and sidecars after the campaign; retain the
small fixture manifests, reports, and exact revision identities needed to reproduce it.
