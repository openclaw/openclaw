# Template prewarm morning replay

`workspace-template-morning-measure.ts` exercises the real managed-worktree and
sandbox-projection owners against seven first-parent main advances. Reuse the
62,000-file repository produced by `sandbox-template-commit-measure.ts`; the
fixture must contain `fixture-base`, its real pnpm lockfile, and its source-dependent
installation script. The input repository is read-only. Every output directory
must be new, and each run clones its own source repository and local origin.
All arms reuse the same physical synthetic agent state described below, opening
fresh storage owners in a fresh process. Copy the replay, seed verifier, and cleanup
helper unchanged into the baseline checkout.

```sh
node --import ./scripts/tsx.mjs scripts/perf/workspace-template-morning-measure.ts \
  --fixture /path/to/synthetic-fixture --output /path/to/new-output \
  --state-dir /path/to/campaign-agent-state \
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
Like the canonical offline fixture caller, it retains the state handle and stops
and joins both handles' periodic WAL maintenance before bulk loading. The writer
still requires each explicit checkpoint to complete. This avoids competing with
Linux sidecar inspection during a long seed; measured arms open fresh owners with
normal periodic maintenance enabled.
`--transcript-mib` measures logical text; canonical transcript/search storage
amplifies those bytes. Bounded 64/256 MiB calibration produced approximately
2.96 database bytes per logical byte, so the full input targets approximately
35 GiB. The full seed must actually contain 10,000 sessions and a 34–36 GiB agent
database, with filesystem-reported allocated bytes at least 95% of file size.
Wrong size fails setup; padding a file or attaching an unrelated database is not
scale proof. `morning-agent-seed.json` records file/page/allocated bytes, row counts,
schema version, source head, seed resources, all seeded metadata's digest, and a
bounded transcript-payload sample digest.

Keep the original seeded file writable at the same path throughout the campaign.
Normal owner shutdown publishes its genuine clean-close seal; the next fresh
process consumes that seal through normal admission. Do not clone the database
between arms: changing physical file identity invalidates the seal and measures a
cold integrity scan before the morning workload. Do not synthesize, copy, or edit
seals, disable admission, or suppress maintenance. Record real admission evidence
and unchanged device/inode/birth-time identity. The replay never deletes the supplied
`--state-dir`. Reserve enough actual host space for an 80 GiB Btrfs loop filesystem,
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

Each arm uses a unique output basename and corresponding session-key namespace.
Cleanup detaches those sessions and retires that arm's worktrees, snapshots,
projections, templates and builders through their existing owners before normal
database close. It preserves all original seed rows. The twelve-arm campaign adds
108 session entries/windows (1.08% of the seeded session count); report actual row,
page and allocated-byte growth after every arm. Registry bookkeeping, maintenance
timestamps and OS cache warmth may carry forward; fresh processes reset JavaScript
caches. Counterbalanced pairs and A/A controls remain mandatory. A failed arm stops
the campaign; do not continue using partially cleaned state. Qualify this lifecycle
first with a small baseline/candidate/baseline sequence, including genuine seal
reuse, seed preservation and zero live workspace/template/builder custody.

Earlier runs with a small agent database or compressed scheduler idle time remain
archived as diagnostic evidence. They cannot qualify this real-time, combined-scale
workload or supply its A/A controls. Record new workload and source hashes; preserve
all earlier failures. Acceptance thresholds and the counterbalanced order are unchanged.

The replay preserves seven advances across thirty real minutes, including three
adjacent advances five seconds apart. Both variants use the same real elapsed clock
and fixed nominal push/request deadlines. Actual arrivals can differ when preceding
foreground work overruns; retain that lateness instead of forcing equal arrival times. Kernel PSI averages and Btrfs commit counters
therefore experience the actual idle intervals; no clock jump, synthetic pressure
value, or treatment-dependent wait grants the candidate extra warm-up time.
The base-refresh owner's real thirty-second freshness interval is preserved; each
observed advance waits at least 30.1 seconds since the preceding completed fetch.
The three-push burst keeps its real five-second gaps and fetches only its final
head, as a single source's freshness window would do. Scheduler debounce across
multiple observations remains covered by focused tests. Native work is never sped
up. Later request waves arrive ninety seconds after each selected push, or later
if preceding work overruns the deadline; retain the actual late arrival.

The nominal measured horizon is 32 real minutes per arm. Allow up to five additional
real minutes for final live settlement, separately measured below. An outer 30-minute
arm timeout cannot execute this schedule. A 60-minute arm bound allows 15 minutes for
excluded per-arm initialization, 32 minutes for the nominal schedule, five minutes
for settlement, and eight minutes for overruns and teardown. These are budget
allowances, not extra delays or success criteria. A deadline failure preserves its
artifacts and stops the campaign; do not extend or retry an adverse sample.
Four initial qualification arms require at least 2 hours 8 minutes of schedule time;
all twelve require at least 6 hours 24 minutes. Their outer arm bounds total four
and twelve hours respectively, excluding shared fixture construction, canonical
agent seeding, source hydration, artifact transfer, and campaign cleanup. Verify the
provider's effective lease/runtime bounds before allocation; a shorter lease is not
made sufficient by compressing idle time, dropping arms, or moving the physical seed.

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
commit has a nominal request deadline 120 seconds after the second advance,
independent of when its preceding foreground wave finishes. After the sixth advance,
another older-commit request has a nominal deadline 31 seconds after that push in
both variants. These are common nominal deadlines, not guaranteed identical actual
arrivals: preserve delays caused by unfinished foreground work. Record whether native
background work actually overlaps; never move an arrival to manufacture overlap.
Focused owner tests prove cancellation. Every consumer must
have the requested HEAD, clean tracked bytes, and, for sandboxes, installation
output derived from that exact source. Managed setup and ignored-file provisioning
are disabled, matching the sandbox source preparation path.

Acceptance requires at least 25% fewer foreground commit-change builds and at
least 30% lower aggregate foreground `templatePrepare` wait, without increasing foreground latency tails or total
process CPU/allocation materially. Report any adverse metric, including canceled
background work; prewarming moves work and may increase total cost. CPU/allocation
spending compares campaign plus settlement in every arm, using the unchanged
thresholds. Also report both components separately; moving deferred work into
settlement cannot remove it from the spending hold. Same-head waiters must share
production builds. Background errors fail the run. Retained
template generations must satisfy the production bound without removing leased
readers; inspect the recorded final registry alongside the owner regression tests.

`results.json` records actual and logical arrival times, whether background work
was still running at each arrival, owner phases, production
preparation diagnostics, host load, exact commits, and final template generations.
The seed is separate. Request-level CPU and allocation overlap under concurrency;
use `wave-*` rows for each concurrent wave and `campaign` for foreground plus
background work through the fixed measured horizon. The separate `settlement` row
records elapsed time, process/thread CPU, main-isolate allocation, initial/final
scheduler deadline and in-flight count, and whether live settlement completed.
Settlement lets native timers and real pressure retries run until there is no
pending wake or in-flight callback. It never advances time, invokes collection
directly, or waits for a desired template count. The five-minute limit fails closed.
Only after successful settlement does the live registry snapshot set
`templateSnapshotWhileLive: true`; the unchanged strict retention check still applies.
When shutdown settles after a failure, retain the partial rows and post-stop fallback
snapshot with this field false. Results are written after awaited scheduler stop;
a stuck callback can prevent final JSON or CPU profiles before an outer TERM/KILL.
Preserve the available prefix, logs and whole-arm artifacts, mark the arm and teardown
incomplete, and never infer cleanup success. Stop-induced cancellation never counts
as successful quiescence. Whole-arm native child/VM accounting includes settlement
and teardown; report these separately
from campaign and settlement CPU/allocation. Their sum is the process CPU/allocation
spending input; whole-arm child/VM costs remain separately reported and reviewed. Summed request `templatePrepare` time describes aggregate user
wait, not total CPU or non-overlapping elapsed work. Diagnostics carrying a
`template.missReason` count actual building callers; joined waiters can still pay
template wait without recording a new build. Main-isolate allocation excludes
workers/native code; process CPU includes JS workers but excludes Git, Docker,
and container CPU. Report these boundaries explicitly.

The script closes its scheduler, retires its recorded resources through the lifecycle
owners, closes storage, and removes its generated source/workspace trees through
the native filesystem owner. `cleanup.json` records the zero-live-custody checks.
The payload retires the shared synthetic state only after the entire campaign.
JSON and runtime logs remain. Cleanup and seed verification are outside
measured rows. The combined workload contains 62,000 payload files /
1,100,004,000 bytes per checkout plus an approximately 35 GiB agent database with
10,000 sessions. It does not claim full Gateway/model/channel startup proof or
cold-cache equivalence. An APFS smoke does not establish Btrfs latency or physical
write behavior. No Team data, credentials, configuration, or running Gateway is used.
