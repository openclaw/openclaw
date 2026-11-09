# Attribute native Gateway allocations

This Linux-only probe runs an isolated, built Gateway on synthetic state and dumps
jemalloc's sampled **live allocations**. It is never loaded by normal launchers.
Use a benchmark host with the same Node and jemalloc versions as the runtime under
investigation. Do not preload it into a production Gateway.

## Run

Build the checkout and generate the fixture on the benchmark host. The Node
distribution's headers must match its executable. The addon resolves `mallctl`
from the preloaded allocator; no repository dependency or installed service changes.

```sh
pnpm build
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /absolute/synthetic-state --port 40982 --settled-runs
cc -O2 -shared -fPIC -I /absolute/node-distribution/include/node \
  scripts/perf/native-allocation-profile.c -ldl \
  -o /absolute/native-allocation-profile.node
node --import ./scripts/tsx.mjs scripts/perf/native-allocation-profile.mjs launch \
  /absolute/synthetic-state /absolute/new-profile-output \
  /absolute/native-allocation-profile.node \
  /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 40982
```

The output directory must not exist. The launcher uses isolated home/temp paths,
loopback binding, no channel startup, and the fixture's configuration. It records
the child PID in `gateway.json` and output in `gateway.log`. Interrupting the
launcher forwards termination to its Gateway. Wait for `/readyz` and startup
maintenance to finish before sampling. Use the built entry: source-mode TypeScript
tooling creates additional isolates and native allocations.

In another shell, select the PID recorded in `gateway.json`:

```sh
node scripts/perf/native-allocation-profile.mjs snapshot \
  /absolute/new-profile-output 12345 sample-1
jeprof --text /absolute/node-distribution/bin/node \
  /absolute/new-profile-output/12345-0.sample-1-dump.heap
```

Use unique sample labels and one controller at a time. A snapshot requests forced
GC from every observed isolate, waits for replies, then captures main-process RSS,
allocator counters, `/proc/self/smaps`, and a jemalloc profile. It rejects a changing
worker census, missing replies, or a failed dump. Each observed worker carries its
ancestor IDs. The surviving parent's exit observer removes the entire terminated
subtree, since native teardown joins descendants without running their JavaScript
exit observers. Keep all observations, including rejected startup samples.

The allocator configuration is
`background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000,prof:true,lg_prof_sample:19`.
This samples roughly one allocation per 512 KiB; small categories have substantial
sampling uncertainty. Profiling, polling, and forced GC perturb the process. Do not
use these runs to gate CPU, latency, natural GC, or promotion.

## Transcript committer checkpoints

The source-mode committer benchmark can use the same preload and addon. Create a
fresh output directory and use the allocator configuration above:

```sh
mkdir /absolute/new-committer-profile
mkdir /absolute/new-committer-profile/home
env -i PATH="$PATH" HOME=/absolute/new-committer-profile/home CI=1 \
  LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 \
  MALLOC_CONF=background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000,prof:true,lg_prof_sample:19 \
  OPENCLAW_NATIVE_PROFILE_DIR=/absolute/new-committer-profile \
  OPENCLAW_NATIVE_PROFILE_ADDON=/absolute/native-allocation-profile.node \
  node --import ./scripts/perf/native-allocation-profile.mjs \
  --import ./scripts/tsx.mjs scripts/bench-worker-transcript-commit.ts \
  --runs 1 --native-profile
```

Snapshots occur after warmup cleanup, before measured commits, after reconciliation
drains, and after fixture cleanup. Compare isolate identities as well as totals to
separate warmup retention from workers opened by the measured fixture. The workload
still checks commit ordering, ledger replay, transcript contents, and publication
counts. A failed snapshot fails the benchmark; inspect partial observations.

This mode requires one sample and a separate pass from `--cpu-profile`. Its output
sets `profiled: true`; checkpoint time stays outside commit timing. Source-mode
loader allocations and internal loader isolates limit attribution: these are not
packaged Gateway RSS measurements, and a residual is not proof of a native leak.

## Interpret

Keep three views separate:

- Per-isolate `process.memoryUsage()`, full V8 heap statistics, and C++ heap statistics.
- Process RSS/PSS and mappings, including file-backed pages and direct mappings.
- Jemalloc allocated, active, resident, metadata, mapped, retained, and allocation stacks.

The reported residual is RSS minus the sum of observed isolate `heapTotal` and
`external`. ArrayBuffers are already included in `external`; do not subtract them
again. The subtraction mixes resident pages with V8 heap capacity and is **not** an
exact native-live-byte total. Per-isolate samples occur at slightly different times;
use a quiet, stable workload and inspect the recorded timestamps and census.

Jeprof includes Buffer storage already counted in `external`. It misses direct
page allocations, including V8 code mappings, C++ heap pages, and thread stacks.
Jemalloc resident bytes include allocator overhead and unused pages; retained bytes
describe virtual address space, not extra RSS. Repeated file mappings can contribute
more RSS than unique physical memory, so inspect PSS before proposing a reduction.
See the [jemalloc statistics contract](https://jemalloc.net/jemalloc.3.html),
[Node memory accounting](https://nodejs.org/api/process.html#processmemoryusage), and
[V8 statistics](https://nodejs.org/api/v8.html#v8getheapstatistics).

Before proposing an owner change, require stable allocation totals and worker
counts across successive samples. Compare changes with at least five alternating
baseline/candidate observations under identical instrumentation and fixtures.
Collect unprofiled timing separately when needed. Runtime flags, allocator options,
or service configuration experiments do not authorize a production configuration
change.

## Initial attribution (2026-10-25)

Measured runtime source: `5281dc3a72b1016ee33b0c0d76c89cc7835acd33`, Node
26.12.1 / V8 14.6.202.34-node.40, Debian jemalloc 5.3.0-4. The synthetic fixture
contained 5,000 sessions, 6,000 settled runs, 200 approvals, 100 disabled cron
jobs, and 12 projects. Channels and plugins were disabled by the fixture. These
are idle, post-startup measurements, not a live-agent or concurrent-client load.
The benchmark ran on an eight-CPU Linux host, at low scheduling priority in a
12 GiB memory-limited scope. No production process was profiled or changed.

Two fresh Gateway processes were observed. The first produced six successful
snapshots: isolate counts `16,16,17,16,16,16`, residual range 197.3–202.0 MiB.
The last three had the same census and less than 0.3% spread in live allocator
bytes, meeting the predeclared stability check. The second reproduced that
window, then demonstrated idle-worker retirement:

| Second process observation        | Isolates (including main) |  RSS MiB | Heap total MiB | External MiB | Residual MiB | Jemalloc allocated MiB | Jemalloc resident MiB |
| --------------------------------- | ------------------------: | -------: | -------------: | -----------: | -----------: | ---------------------: | --------------------: |
| 2                                 |                        16 | 1,072.44 |         811.59 |        62.50 |       198.34 |                 156.61 |                210.50 |
| 3                                 |                        16 | 1,073.09 |         811.84 |        62.50 |       198.74 |                 156.06 |                210.19 |
| 4                                 |                        16 | 1,072.34 |         811.84 |        62.50 |       198.00 |                 155.57 |                208.79 |
| 5                                 |                        16 | 1,072.33 |         812.34 |        62.50 |       197.49 |                 155.07 |                207.90 |
| 6, after five workers retired     |                        11 | 1,014.80 |         644.62 |        45.74 |       324.44 |                 119.57 |                186.45 |
| Later post-retirement observation |                        11 |   871.03 |         644.62 |        45.74 |       180.67 |                 117.83 |                167.04 |

The second process's initial collection was rejected because a worker exited
during the snapshot. Its five subsequent observations are shown without trimming
the retirement phase. These are repeated time points, **not five independent A/B
pairs**. No production optimization candidate or throughput claim is established.

The 16-isolate census comprised main, five session-transcript workers, two SQLite
store workers, and one each of filesystem watching, model catalog, discovery,
client credentials, native lifecycle, state reads, state ownership heartbeat, and
state lease heartbeat. Idle retirement removed the five transcript workers. The
temporarily increased residual after retirement is not increased live allocation:
the heap subtraction shrank before all resident pages were returned.

Jeprof's collapsed stacks from the stable first-process final observation and
second-process observation 4 gave the following mutually exclusive attribution.
The profiles contained 290 and 293 sampled live allocations, respectively.
Categories use the complete caller stack, not merely the allocator leaf.

| Allocation family                | First process MiB | Second process MiB |
| -------------------------------- | ----------------: | -----------------: |
| Node module/package loading      |              48.9 |               44.7 |
| Other V8 allocations             |              24.1 |               26.0 |
| V8 CPU-profiler metadata         |              19.5 |               18.9 |
| SQLite                           |              18.1 |               20.2 |
| V8 heap-page metadata            |              18.1 |               16.6 |
| ArrayBuffer backing stores       |              13.4 |               15.2 |
| ICU                              |               2.1 |                2.2 |
| OpenSSL                          |               0.5 |                2.0 |
| Other Node                       |               0.5 |                0.5 |
| Total estimated live allocations |             145.2 |              146.4 |

No compression context or libuv allocation appeared as a large sampled category;
absence of a sample does not prove zero cost. These totals overlap `external` and
must not be added to it. Sampled estimates differ from exact allocator counters.
The stripped allocator labels one internal C++ allocation helper as
`operator delete[]`; its mapped library, disassembly, and caller frames identify
an allocation path. Treating that label as the owner would be incorrect.

Module-loading stacks include `ParsePackageJSON`, simdjson capacity, native
package strings, and `ModuleWrap`. CPU-profiler stacks include
`SourcePositionTable::SetPosition` (8.0–9.5 MiB), code registration, weak code
handles, and profiler strings. The continuous stall recorder deliberately retains
that code map. Node exposes only interval and sample-buffer controls, while V8
builds source-position tables during code registration. Reducing the sample limit
does not remove these tables. Ending the final profile would release the map but
reintroduce code enumeration when profiling resumes; that is not an equivalent
small optimization. See [Node's options](https://github.com/nodejs/node/blob/v26.12.1/lib/internal/v8/cpu_profiler.js),
[V8 table construction](https://github.com/nodejs/node/blob/v26.12.1/deps/v8/src/profiler/profiler-listener.cc),
and [profiler lifecycle](https://github.com/nodejs/node/blob/v26.12.1/deps/v8/src/profiler/cpu-profiler.cc).

The second process also reported 23.4 MiB allocator metadata and about 25–26 MiB
active-minus-allocated space. Its Node executable mappings had approximately
82.7 MiB RSS but 31.1 MiB PSS; these are mapping observations, not additional
allocations. Observed C++ heap residency totaled only 68 KiB across 16 isolates.
Neither C++ heaps nor compression contexts explained a large missing baseline.

Calibration retained a known 64 MiB Buffer and then released it with forced GC:
allocator allocation rose by 64.05 MiB and fell by 63.73 MiB; `external` moved by
64 MiB in both directions. Jeprof attributed 64.5 MiB to its backing allocation.
This was one calibration sequence, not a performance comparison. Terminated-worker
census cleanup passed, and nonempty mapping capture was verified after replacing
`copyFileSync` on procfs. Early source-mode and failed-census probes were exploratory,
not acceptance samples.

**Decision:** retain the measurement tooling; change no production ownership,
worker lifetime, diagnostics, or host flags. The built synthetic workload explains
an approximately 200 MiB residual, not arbitrary larger production baselines.
Its missing traffic, plugin activity, agent work, and worker mix prevent a direct
production extrapolation. A further optimization needs the responsible owner's
representative workload, a behavior-preserving candidate, and alternating paired
proof. No deployment memory drop is claimed for this instrumentation-only change.
