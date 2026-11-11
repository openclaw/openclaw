# Template prewarm morning replay

`workspace-template-morning-measure.ts` exercises the real managed-worktree and
sandbox-projection owners against seven first-parent main advances. Reuse the
62,000-file repository produced by `sandbox-template-commit-measure.ts`; the
fixture must contain `fixture-base`, its real pnpm lockfile, and its source-dependent
installation script. The input repository is read-only. Every output directory
must be new, and each run clones its own source repository and local origin.
Each arm also requires a pristine writable snapshot of the synthetic agent state
described below. Both fixture entrypoints must be copied unchanged into the
baseline checkout.

```sh
node --import ./scripts/tsx.mjs scripts/perf/workspace-template-morning-measure.ts \
  --fixture /path/to/synthetic-fixture --output /path/to/new-output \
  --state-dir /path/to/pristine-writable-state-snapshot \
  --image local-node-pnpm-image --prewarm
```

Run the baseline without `--prewarm` from a full exact-parent checkout with the
same workload script. Run the candidate from its frozen checkout. Disabling the
subscriber in changed production code is not an exact-parent comparison. Never
mix candidate source with baseline compiled workers. Use at least five samples
per arm in counterbalanced order and matched baseline A/A controls on the same
host; record source hashes and the image identity with the campaign results.

For lane 2416, the baseline is `3a6cc659` plus the isolated known-ID registry-guard
repair from `694ffbdda9f5d`, also present in the candidate. The unmodified parent
failed the concurrent owner-resolution flow because unrelated publication revoked
its wildcard read. Record the exact single-file repair patch hash and resulting
baseline tree; do not copy the candidate projection module, which also contains
prewarm changes. Preserve the original failed run separately.

Create the agent-state seed once, outside every measured arm, using the existing
canonical session/transcript fixture writer:

```sh
nice -n 19 node --max-old-space-size=2048 --import ./scripts/tsx.mjs \
  scripts/perf/workspace-template-agent-seed.ts \
  --state-dir /path/to/empty-seed-state --sessions 10000 --transcript-mib 12096
```

The helper generates deterministic synthetic session metadata, participants and
real transcript rows for agent `fixture`. It adds no tables or schema changes.
`--transcript-mib` measures logical text; canonical transcript/search storage
amplifies those bytes. Bounded 64/256 MiB calibration produced approximately
2.96 database bytes per logical byte, so the full input targets approximately
35 GiB. The full seed must actually contain 10,000 sessions and a 34–36 GiB agent
database, with filesystem-reported allocated bytes at least 95% of file size.
Wrong size fails setup; padding a file or attaching an unrelated database is not
scale proof. `morning-agent-seed.json` records file/page/allocated bytes, row counts,
schema version, source head, seed resources, all seeded metadata's digest, and a
bounded transcript-payload sample digest.

On Btrfs, create the seed directory as a subvolume, let the helper close all storage
owners, mark that seed read-only, then create one writable subvolume snapshot per
arm. This shares the 35 GiB immutable extents rather than copying them for every
sample. The payload owns these snapshots and removes each only after the replay
exits and its builders/storage owners settle. The replay never deletes the supplied
`--state-dir`. Reserve enough actual host space for an 80 GiB loop filesystem,
tooling and host headroom; require at least 96 GiB free after tooling preparation.
The loop must fit the seed, workspace/template working set and the real owner's
8 GiB safety reserve. A 40 GiB loop cannot hold this combined fixture safely.
Seed serially at low priority, keep Node's heap bounded, record peak RSS and CPU,
and retain Linux dirty-memory/disk admission guards. Do not seed during timings.

All arms use the same existing session-maintenance settings: `mode: enforce`,
`maxEntries: 20000`, `pruneAfter: 365d`, `archiveDashboardAfter: 365d`,
`maxDiskBytes: 64 GiB`, and `highWaterBytes: 48 GiB`. Maintenance stays enabled;
these fixture limits keep the deliberately large history below eviction thresholds.
Defaults of 5,000 entries and 10 GiB would prune the seed and change the workload.
Before first use and after all storage owners close, the replay verifies seeded
metadata, transcript count/sample digest and schema version. A complete arm adds
exactly nine session entries/windows through the normal writer. Results retain the
before evidence; `agent-state-after.json` records the verified final shape. Source
and installer-output assertions still apply to every foreground request.

Earlier runs with a small agent database remain archived separately and cannot
qualify this combined scale requirement. The push pattern, request composition,
idle compression, acceptance thresholds and A/A/paired order are unchanged.

The replay preserves seven advances across a logical thirty-minute morning,
including three adjacent advances five seconds apart. Only scheduler idle time
is compressed through its existing clock interface. The base-refresh owner's
real thirty-second freshness interval is preserved; each observed advance waits
at least 30.1 seconds since the preceding completed fetch. Native Git, filesystem,
installation, cancellation, and foreground execution run at actual speed. The
three-push burst preserves its real five-second gaps and fetches only its final
head, as a single source's freshness window would do. Scheduler debounce across
multiple observations is covered separately by its focused tests. The injected
clock advances at real speed during native work and foreground requests, and
uses real timers, so a deadline can start background work during a slow request.
Only settled idle intervals advance through an offset. Nominal later request
waves arrive ninety seconds after each selected push, or later if real work
overruns that deadline. Record any such late arrival instead of changing native
execution speed. This is an owner workload with compressed idle intervals, not
a measurement of a thirty-minute Gateway wall-clock session.

The seed activates managed source-only and sandbox template recipes. Each observed
head is discovered by a real default-base managed request with no explicit commit.
That request's fetch, hydration, template miss, and startup latency are charged to
the foreground. There is no artificial periodic refresh before the first user.
Sandbox consumers register their synthetic session through the normal session
entry writer and call `prepareLocalSandboxWorkspace`, including its reuse,
authority, allocation, and foreground-priority ownership.
After that request settles, the scheduler can prewarm during the following idle
interval. Each later measured wave creates a managed-only consumer and a managed-plus-sandbox consumer for the
same head, with an additional sandbox waiter after the rapid-push burst. An older
commit is requested after the second advance. After the sixth advance, another
older-commit request arrives 100 ms after the background scheduler wake, exercising
foreground priority while native work can still be running. Every consumer must
have the requested HEAD, clean tracked bytes, and, for sandboxes, installation
output derived from that exact source. Managed setup and ignored-file provisioning
are disabled, matching the sandbox source preparation path.

Acceptance requires at least 25% fewer foreground commit-change builds and at
least 30% lower aggregate foreground `templatePrepare` wait, without increasing foreground latency tails or total
process CPU/allocation materially. Report any adverse metric, including canceled
background work; prewarming moves work and may increase total cost. Same-head
waiters must share production builds. Background errors fail the run. Retained
template generations must satisfy the production bound without removing leased
readers; inspect the recorded final registry alongside the owner regression tests.

`results.json` records actual and logical arrival times, whether background work
was still running at each arrival, owner phases, production
preparation diagnostics, host load, exact commits, and final template generations.
The seed is separate. Request-level CPU and allocation overlap under concurrency;
use `wave-*` rows for each concurrent wave and `campaign` for total foreground plus
background work. Summed request `templatePrepare` time describes aggregate user
wait, not total CPU or non-overlapping elapsed work. Diagnostics carrying a
`template.missReason` count actual building callers; joined waiters can still pay
template wait without recording a new build. Main-isolate allocation excludes
workers/native code; process CPU includes JS workers but excludes Git, Docker,
and container CPU. Report these boundaries explicitly.

The script closes its scheduler, retires only builders registered in its isolated
state, closes that state, and removes its generated source/workspace trees through
the native filesystem owner. The payload separately retires the supplied state
snapshot. JSON and runtime logs remain. Cleanup and seed verification are outside
measured rows. The combined workload contains 62,000 payload files /
1,100,004,000 bytes per checkout plus an approximately 35 GiB agent database with
10,000 sessions. It does not claim full Gateway/model/channel startup proof or
cold-cache equivalence. An APFS smoke does not establish Btrfs latency or physical
write behavior. No Team data, credentials, configuration, or running Gateway is used.
