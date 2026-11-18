# Compacted same-session cron facts proof

This synthetic owner workload creates transcript rows through `persistSessionTranscriptTurn`
and compactions through `SessionManager.appendCompactionAsync`. It does not insert transcript
rows with SQL. The only deliberate historical-state mutation deletes companion facts outside
its natural 512-row recent window. The production backfill kernel restores those facts, and
its complete facts rows must exactly equal the natural writers' rows.

The main synthetic workload alternates ordinary historical messages with excluded dashboard
assistant posts (`excludeFromContext: true`), then has an ordinary post-compaction tail.
This is a declared workload composition, not a claim that half of Team rows are excluded.
`--ordinary-history` removes exclusions to test why ordinary compacted cron history may be
neutral. No unresolved pending automation results are created; those intentionally remain
context dependencies and must retain their payload reads.

The primary cron open is `SessionManager[sessionManagerOpenTranscriptCohort]` with the
`cron-model` hydration caller and
`resolveEmbeddedSessionContextLimits({})`: 1,024,000 bytes and 10,000 events. This follows the
same bounded history worker request used by same-session cron model attempts. It selects
empty entry IDs with message presence, matching the owned-reader branch without an initial
user-turn cohort lookup. `--open-path simple` exercises the alternate `SessionManager.openAsync`
branch as an explicit smoke control. Both paths must return identical entries and model messages. The worker
labels it `sessions.transcript-hydration.cron-model`; the harness does not substitute an
unbounded context reader or a hand-built SQL query. No model inference is needed to open it.

Run all fixture commands on SF1; leave TMPDIR unchanged. Only the small test state lives in
the private default temporary directory. The explicitly addressed synthetic agent database
and its copies live under `--output`. `--smoke` creates a 2,001-row shape for setup validation.

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-cron-model.ts --output "$PWD/.local/facts-cron" --shape frv --mode prepare
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-cron-model.ts --output "$PWD/.local/facts-cron" --shape frv --mode backfill
node --import ./scripts/tsx.mjs scripts/perf/transcript-facts-cron-model.ts --output "$PWD/.local/facts-cron" --shape frv --mode measure --phase all --samples 5
```

Repeat with `--shape shellbench`. Output files are exclusive: use a new output directory for
another campaign. Every measured open refuses one-minute host load above 40. CPU is process
CPU, including worker execution and preparation. Closing the agent database between samples
makes native reader caches fresh; OS cache is not evicted, and no physical-cold claim follows.
The existing VFS probe is installed process-wide with an opt-in exact database/WAL filter;
config and profile databases are excluded. An opt-in forced xFetch miss prevents worker
mmap from bypassing counted xRead calls, symmetrically in all arms. Atomic counters observe
worker threads. The default `--phase all` order alternates before/after/natural and its reverse
for five rounds, with cross-state result equality required. VFS bytes and read spans include
repeated reads; they are not file size or physical disk bytes. macOS process physical read
counter deltas are reported separately. Entry and final model-message hashes must agree across all states. Model context assembly
runs after the measured open; its time is not included. Treat
small timing movements as context; the decisive question is whether historical payload
reads disappear and reads approach the selected post-compaction tail.

After measurement, `--mode inspect` performs another real cohort open, checks both result
hashes against the campaign, and records its selected payload IDs/sequences/types plus
coverage, off-path, pending-result, cold-state and metadata-only `dbstat` inventory. This is
a separate attribution pass, not another timing sample. Metadata object sizes are storage
footprints, not per-object I/O attribution.

After the campaign, delete the three synthetic SQLite files per shape and their WAL/SHM
files; retain manifests, raw measurements and the summarized report. This workload measures
read benefit, not backfill pacing or foreground contention.
