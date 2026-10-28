# Code Mode engine investigation

Investigation date: October 27, 2026. This record separates engine measurements,
the production execution owner, and the remaining end-to-end qualification.

## Decision and boundaries

Keep QuickJS available as an explicit capability-restricted executor. Node is
already the default executor; removing QuickJS cannot accelerate that default.
An absent global Code Mode
setting uses automatic model activation. Activation and executor selection are
separate decisions.

QuickJS is an interpreter compiled to WebAssembly. WebAssembly does not turn the
guest JavaScript into V8 JIT code. CPU-heavy guest loops should not be expected to
outperform native V8. The current WASM build also favors size (`-Oz`). An
alternative speed build has not been measured.

Node's `node:vm` is trusted execution, not an isolation boundary. Both executors
currently use worker threads in the Gateway process. QuickJS removes ambient
filesystem, network, process, environment and module capabilities from its guest;
authorized bridge tools still retain their capabilities. Neither worker layout
establishes an OS sandbox. Session tool sandboxing does not relocate the guest.

`memoryLimitBytes` bounds QuickJS guest memory. Node's V8 worker heap budget excludes
external buffers and native allocations. Neither setting, the 64 suspended-cell
limit, nor snapshot byte accounting caps total Gateway RSS. No escape or Gateway
out-of-memory failure was demonstrated by this investigation.

## Existing implementation and history

- `0844e771a8d` introduced the early QuickJS Code Mode worker: authored May 11,
  committed May 15, 2026.
- `09e06495a3980cd74623951442d6e8ce4b777779` separated the Node and bundled QuickJS
  executors on September 21, 2026. See
  [the executor change](https://github.com/openclaw/openclaw/pull/154522).
- Current selection is in `src/agents/code-mode-runtime.ts`; continuation and
  bridge ownership are in `code-mode-execution.ts` and `code-mode-state.ts`.
- The plugin already compiles and retains the WASM module and encoding extension
  lazily in `src/executor.ts`. Repeated WASM compilation is not the warm-cell bug.
- Node retains a live context across suspension. QuickJS copies linear memory
  into a transferable snapshot, releases its worker, then restores an independent
  guest heap. Continuations are one-shot, engine-pinned and process-local.

These dates identify source history, not release-tag reachability or fleet
adoption. Production use of explicitly selected QuickJS was not inventoried.

## Measured baseline

Source: `882622be3833a390cb434fd7b29af2529f2cc2fc`, tree
`72bd8b23ac77716ee76c475869336932142398cd`, on
`test/code-mode-engine-validation-20261027`, based on
`2a37974b97338c9ff354bbc734f7639e2d23ab78`. Later test type/style corrections
did not change the timed workloads; their commits are not the measured source.

The owner probe executes the real public `exec`/`wait` path, catalog projection,
bridge policy and production workers, with deterministic mock external tool I/O.
A resource host and scheduler keep Node workers warm as in production. There is
no model/provider, network call, retry or randomized task seed in this workload.

Environment: Blacksmith Testbox, Linux x64, Node 24.22.1, AMD EPYC, 16 visible
vCPUs. Observed one-minute host load was 1.22–3.14. Visible CPU count is not proof
of a guaranteed allocation or effective cgroup quota. Runs were serial: five
alternating independent process pairs, eight timed cells and three warmups per
scenario. Total: 880 timed cells, 330 warmups, 14,160 timed mock bridge calls.

Values below are the median of five per-process medians, in milliseconds. The
independent comparison unit is a process pair, not each pooled cell.

| Warm scenario                     |   Node | QuickJS 3.6.2 |
| --------------------------------- | -----: | ------------: |
| Empty catalog, no-op              |  1.393 |         4.499 |
| 160-entry catalog, no-op          |  2.287 |         7.180 |
| CPU loop, 100,000 iterations      |  3.133 |        10.104 |
| CPU loop, 1,000,000 iterations    |  3.054 |        34.218 |
| 16 sequential ordinary calls      |  7.038 |        12.251 |
| 16 sequential required calls      | 10.668 |        45.340 |
| 64 sequential ordinary calls      | 17.382 |        24.083 |
| 64 sequential required calls      | 38.173 |       152.667 |
| 16 joined calls                   |  3.647 |         7.454 |
| 128 KiB tool reply, return length |  3.509 |         7.130 |
| Approximately 64 KiB final JSON   |  5.138 |        11.824 |

The 64-required-call process medians ranged from 26.189–49.105 ms for Node and
139.212–162.115 ms for QuickJS. CPU-million medians ranged from 2.690–6.669 ms and
31.166–36.856 ms respectively. Eight samples per process give coarse, maximum-like
p95 values; this experiment does not establish production tail latency.

Ordinary sequences use one worker task. Required sequences used 17 or 65 tasks
for 16 or 64 calls: the owner resumed checkpoints internally, with no public
`wait` round-trip. Zero public waits therefore does not mean zero snapshots.

The first source-worker cell in each process ranged from 123.992–173.920 ms for
Node and 1193.150–1402.980 ms for QuickJS. This includes source-worker bootstrap
and lazy initialization; it is not packaged startup or an isolated WASM compile
measurement. Do not compare later first-cell samples as equivalent cold starts.
Sampled process RSS between cells is neither engine peak RSS nor Gateway RSS.
QuickJS's process-wide pool survives between scenarios, while each Node resource
host closes its pool after its scenario. Warmups protect the timed comparison;
later first-cell samples must not be treated as matching cold starts.

## Attribution and dependency contract

`engine-attribution.ts` separates VM creation, input conversion, controller
initialization, CPU, snapshot copying and restore. Five interleaved process pairs
compared 3.6.2 and 3.6.3 with 12 samples per phase.
Both arms used source `882622be3833a390cb434fd7b29af2529f2cc2fc`, tree
`72bd8b23ac77716ee76c475869336932142398cd`. Their controller SHA-256 was
`44e1c8935dfb129771f608a9bdb1b61e59fb48d372dd657b19d42bc27f41dfed`;
attribution harness SHA-256 was
`2cd5a21e67ab2e699244c2cdbc66146a4838085474f5582cc28f1df4bf33c0ba`.

- For a 160-entry catalog, QuickJS VM creation was 0.558 ms, host-to-guest input
  conversion 0.759 ms, and controller source initialization 3.128 ms. Trusted
  controller bytecode reduced that last phase to 2.041 ms in the raw probe.
- At 1,000 entries, input conversion was 4.140 ms and source controller
  initialization 12.629 ms. Catalog-dependent setup remains material.
- The million-iteration QuickJS loop took 25.379 ms without interrupts and
  25.434 ms with the production deadline check. Disabling checks does not explain
  or repair the CPU gap. A counted deadline arm measured 25.426 ms.
- Retaining 8 MiB increased linear memory to 9,764,864 bytes. Snapshot copy took
  1.822 ms and restore 2.224 ms, versus 0.336/0.543 ms with no retained payload.
  These are individual phases, not complete suspend/resume latency.
- An unsymbolicated 100-round CPU profile spent 44.885% of sampled time in one
  WASM function. This supports an engine cost, not a named C-function or Gateway
  hotspot claim.

[3.6.3](https://github.com/vercel-labs/quickjs-wasi/releases/tag/quickjs-wasi@3.6.3)
releases both deferred-promise resolver handles after first settlement. The raw
32 × 64 KiB retention fixture retained 2,105,560 bytes on every 3.6.2 arm and zero
on every 3.6.3 arm. Current Code Mode does not call `QuickJS.newPromise`; this
fixture does not prove a current Code Mode leak. CPU and snapshot phases showed
no meaningful improvement from the patch release.

Both packages contain identical assets:

| Asset          |  Bytes | SHA-256                                                            |
| -------------- | -----: | ------------------------------------------------------------------ |
| `quickjs.wasm` | 637405 | `d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9` |
| `encoding.so`  |   7715 | `d501aa2a8410ee07c196103f0d169b226ec61c922883713510fd723fe14036c3` |

The qualified candidate pins 3.6.3 in the plugin manifest and `pnpm-lock.yaml`, with integrity
`sha512-gDXhV2yi6oyVcGPYnACIzVbMNsmMlwjryhh3vAk8K589Xk/J06fb2SGbx8GJQnxyJv43pdrNbfP815dTkSYb9g==`.

Source workers resolve dependency exports; built workers read copied plugin
assets. Both paths require qualification after a pin update. The package worker
sentinel alone does not establish that QuickJS assets load. Bun's synchronous
GC/transfer lifecycle tests cover a distinct contract from Node-only GC tests.

## Repairs driven by the investigation

The initial runtime repairs were first recorded in investigation commit
`363369267c1788606c93d4e056717074a9e55f08`, followed by the rejection-tracker
repair qualified below. These historical identities predate publication as
separate PRs. The baseline measurements predate the repairs; candidate
qualification applies to the assembled runtime.

1. **Bound diagnostic materialization at the guest boundary.** The original
   QuickJS rejection path called `vm.dump()` before clipping the message. Its
   recursive host conversion densified sparse arrays and visited object getters.
   A 64,000-slot sparse rejection became 64,000 host elements, with roughly
   2.7–8.2 MB sampled host heap deltas. This was bounded diagnostic evidence, not
   a demonstrated Gateway OOM. The shared guest encoder records bridge identity
   first, catches diagnostic-property failures, clips primitive strings before
   crossing into the host, and never recursively serializes thrown objects.
   Node consumes the same encoder. Exact final JSON/UTF-8 output fitting remains.
   Deeper review also found that guest changes to rejection-set methods could
   throw into the dependency's eager `JSException` constructor before encoding.
   The controller now captures `add`, `delete`, `values` and iterator `next`
   before guest execution. Regressions cover each operation, handled rejection
   after restore, original diagnostics and recovery in a fresh cell.
2. **Avoid checkpoints for immediately settled required replies.** Unconditional
   parking originated with off-VM required-wait budgeting in `98f9d597f7d`.
   Preserve that design for genuine waits. Give immediate promise chains one
   scheduler turn, charged to the original allowance, then continue only a ready
   settlement frontier. Cancellation and pressure still force parking. A large
   guest can consequently finish a fast sequence without requiring a snapshot.
3. **Reuse trusted controller compilation.** Cache one controller bytecode buffer
   per worker/build, retaining source/debug metadata. Each fresh VM still gets
   its own heap, catalog, limits and globals. No guest state, disk bytecode cache,
   caller-provided bytecode or cross-version reuse is introduced.
4. **Take the maintenance patch through real packaging.** Keep the dependency
   plugin-local and preserve explicit selection and fail-closed availability.
   Do not advertise the patch as an engine speed upgrade.

All changes must preserve cumulative guest grants, charged guest timers,
approval pauses, exact-once tool effects, settlement ordering, one-shot
continuations, cancellation/catalog disposal and compute fairness. The focused
owner tests and worker lifecycle tests exercise these contracts. Performance
acceptance requires fewer required worker legs plus five interleaved baseline
and candidate process arms, with warm latency improving and no material cold,
ordinary-call or CPU regression. A 20% adverse move requires investigation.

This closes the identified rejection and tracker paths. It does not establish a
universal host-allocation cap for dependency exceptions: synchronous
`JSException` construction still eagerly converts guest error properties.
An upstream raw-exception-handle API, or equivalent audited boundary, is a named
follow-up before claiming every diagnostic path is bounded.

## Candidate qualification

Behavioral and build proof qualified the complete candidate tree
`798e2a4456ebc2a675eb0380f9ec3ded2e39a0ca`. At measurement time, it combined
commit `93d5ad1edb2bd2285d97a3a69bc0f440603cad9b` with an uncommitted
rejection-tracker repair and 3.6.3 pin. The commit alone therefore does not
identify the qualified candidate. Publication as separate PRs changes commit
history; these measured identities remain historical provenance. The combined
qualification does not establish that every intermediate PR head passed the
same checks. Later report-only updates do not change these runtime files.

| Runtime file                                           | Candidate SHA-256                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `extensions/code-mode-quickjs/src/code-mode.worker.ts` | `874cb27840f8043c3286c28c2a8c94632408bb67fbd5e1b6c22c4997cbd7aa2a` |
| `src/agents/code-mode-controller-source.ts`            | `24ea7e711082b2be8351b5a2c526068b4b95540d9e3bc208eb10478d3652783c` |
| `src/agents/code-mode-execution-budget.ts`             | `26de3aecb6906c8f4abfb6448c64710bbae6bb4f4d4e48389b939411c33da2e0` |
| `src/agents/code-mode-execution.ts`                    | `37637c3ba0577df19ceeaab179d53caaf9fb22ad5ee21403fac27eeaedbddb1e` |
| `src/agents/code-mode-node.worker.ts`                  | `d2577cd902de4691c12ce3293deb03afe24af6436a19b9dbdc9b6bf130369b87` |

- Actual installed `quickjs-wasi` 3.6.3 and a frozen-lock installation passed.
- Previous tracker code, replayed on the same 3.6.3 graph, failed all four
  QuickJS prototype-mutation regressions; all four Node cases passed.
- The repaired tree passed 192 focused tests across nine files on Node 24.22.1.
  Coverage includes both engines, failure classification/output limits, real
  checkpoints, mixed draining, cancellation, pressure, disposal and fresh-cell
  recovery. Covered side-effect assertions showed no replay.
- The source-pinned Bun `1.4.4-canary.1+807211511`, verified by executable
  SHA-256 `5bcf675cba3ff588ebd6fdefeffcb9ad70d8baec94fe5f47ddac077f61becf21`,
  passed 45 parity/lifecycle tests. These overlap the Node cases and are not
  45 additional unique tests.
- Core test-shard types, plugin types, scoped core lint, assertion-safety
  ratchet and config-docs validation passed.
- The official `qaRuntime` build profile passed. Copied WASM/encoding asset
  hashes matched the installed dependency. The built public executor suspended
  with a retained 1 MiB array, transferred a 2,621,440-byte snapshot and resumed
  to value `42`, preserving before/after output. This is built-runtime proof,
  not a full release package or packaged cold-start benchmark.
- Docs validation passed, including the MDX check of 1,413 files. This focused
  qualification does not establish full CI success.

The original sparse-array/object diagnostic tests also failed on the original
runtime before the bounded encoder repair. Those and the tracker replay are
expected red tests; they are not failures of the qualified candidate.

### Matched production-owner measurements

The completed comparison replayed the five original runtime files from
`53d9e6412c05d1ff315b590c81240d6250b914a7` against the qualified candidate
above. **Both runtime arms used the actual installed 3.6.3 dependency graph.**
This compares the runtime repairs collectively; it does not isolate an individual
repair and is not a 3.6.2-versus-3.6.3 speed claim.
Each overlay and the common probe were SHA-256 checked before each process.
The unchanged owner-probe SHA-256 was
`aa5013a745c9fca6d780ffb5b36cd333fdb1a255a3e756a6bc625f4d4dbcb8a6`.

Five matched rounds included a baseline/candidate process pair for each engine,
alternating arm order and reversing engine order.
The 20 processes completed 220 scenario rows, 1,760 timed cells, 660 warmups and
28,320 timed mock bridge calls. Every timed cell asserted the expected result,
exact tool-call count and no active run. All processes succeeded, and the five
candidate runtime files were restored and hash-checked afterward.

The same Linux x64 Node 24.22.1 lease exposed four AMD EPYC CPUs, affinity/cpuset
`0-3`, and 16,555,134,976 bytes of visible memory (15.42 GiB). One-minute load
ranged from 1.73 to 2.77. Queried CPU/memory quota files were absent; the enormous
`process.constrainedMemory()` sentinel was not a usable memory limit. This is
four visible CPUs despite the requested runner tier. Compare paired arms within
this campaign; absolute times must not be compared with the earlier 16-visible-CPU
baseline as a before/after result.

Values are milliseconds: the median of five process medians, each from eight
timed cells after three warmups. These are complete owner calls, including fresh
guest/controller setup; CPU rows do not isolate loop execution.

| Warm scenario                     | Node baseline | Node candidate | QuickJS baseline | QuickJS candidate |
| --------------------------------- | ------------: | -------------: | ---------------: | ----------------: |
| Empty catalog, no-op              |         2.475 |          2.510 |           10.604 |             5.579 |
| 160-entry catalog, no-op          |         4.693 |          4.975 |           16.268 |             8.621 |
| CPU loop, 100,000 iterations      |         5.894 |          7.425 |           18.516 |            11.897 |
| CPU loop, 1,000,000 iterations    |         6.171 |          6.923 |           66.433 |            47.070 |
| 16 sequential ordinary calls      |        14.102 |         14.383 |           31.622 |            18.400 |
| 16 sequential required calls      |        14.729 |         13.799 |          108.158 |            15.490 |
| 64 sequential ordinary calls      |        31.533 |         33.463 |           51.123 |            41.480 |
| 64 sequential required calls      |        50.185 |         28.642 |          326.203 |            35.813 |
| 16 joined calls                   |         9.107 |          6.762 |           12.237 |            11.637 |
| 128 KiB tool reply, return length |         7.299 |          7.162 |           12.030 |            10.321 |
| Approximately 64 KiB final JSON   |         9.250 |          7.813 |           20.773 |            15.117 |

For 64 required calls, QuickJS's paired candidate/baseline ratios were
0.213, 0.0727, 0.0772, 0.111 and 0.0983. All five improved; the median ratio was
0.0983. Node's ratios were 0.694, 0.733, 0.423, 0.382 and 1.085: median 0.694,
range 0.382–1.085, including one adverse pair.
Do not substitute the ratio of the aggregate medians for these paired summaries.
For 16 and 64 required calls, worker legs fell from 17/65 to one in both engines.
Public waits remained zero: the removed work was internal checkpoints.

The 64-required-call process CPU medians fell from 8,635 to 801 ms for QuickJS
and 1,032 to 735 ms for Node. These process totals cover three warmups (including
the first cold cell), eight timed cells and harness overhead; they are not CPU
per warm cell.
The median worker-run total divided by eight fell from 284.54 to 34.40 ms for
QuickJS and 37.72 to 26.61 ms for Node. Worker run and host-wait diagnostics
overlap and must not be added as exclusive phases.

First-process source-worker startup ranged from 189–282 to 175–313 ms for Node,
and 2,179–3,989 to 1,875–2,068 ms for QuickJS. This does not qualify packaged
cold startup or equivalent coldness in later scenarios. Between-cell process RSS
samples ranged from 1,015–1,601 MiB baseline and 983–1,114 MiB candidate for Node,
and 1,116–1,370 versus 1,229–1,355 MiB for QuickJS. These include the source test
harness and its caches. They establish neither a memory reduction, an engine
leak, a peak bound nor Gateway RSS.

The Node 100,000-iteration row crossed the adverse threshold: aggregate medians
increased 26%, paired median ratio 1.218, range 0.813–1.912. Ordinary sequential-16
increased only 2% in aggregate, but its paired median ratio was 1.299, range
0.726–1.412. These signals triggered the longer follow-up below.

### Node adverse-signal follow-up

This separate five-pair comparison used 40 timed cells and three warmups per
scenario, adding no-op and million-iteration controls. Ten processes completed
40 scenario rows, 1,600 timed cells, 120 warmups and 6,400 timed tool calls.
All processes returned exit zero and restored/hash-checked the candidate files.
The source capsule was `1a4ebdd8bb60e86983489fad5697ba2087f49d40`; its changes
from the qualified `798e2a4456ebc2a675eb0380f9ec3ded2e39a0ca` tree were report-only. The five runtime SHA-256
identities and common probe were unchanged. It used the same lease and dependency
graph, with observed one-minute load 1.00–3.34. Do not pool it into the eight-cell
campaign.

Source review found that neither affected scenario enters the new required-wait
scheduler branch. The CPU case makes no bridge request; ordinary calls have
`awaitResults: false`. Their shared changed cost is fresh-context controller
initialization: captured rejection/encoding intrinsics and an output-limit input.
Node still compiles its trusted controller once per worker. Diagnostic encoding
is not executed on these successful cells. Initialization is a plausible fixed
cost, but this does not prove it caused the earlier measured increase.

The table retains all pair medians and order. B is baseline, C is candidate;
ratio means candidate/baseline. Each row represents a process estimate, not
40 independent process samples.

| Pair | Order | Scenario               | Baseline ms | Candidate ms | Delta ms | Ratio |
| ---: | ----- | ---------------------- | ----------: | -----------: | -------: | ----: |
|    1 | B → C | noop-160               |       2.088 |        2.236 |    0.147 | 1.071 |
|    1 | B → C | cpu-100k               |       2.959 |        3.128 |    0.169 | 1.057 |
|    1 | B → C | cpu-1m                 |       2.878 |        2.903 |    0.025 | 1.009 |
|    1 | B → C | sequential-16-ordinary |       6.187 |        5.738 |   -0.449 | 0.927 |
|    2 | C → B | noop-160               |       4.495 |        2.542 |   -1.954 | 0.565 |
|    2 | C → B | cpu-100k               |       6.495 |        3.126 |   -3.368 | 0.481 |
|    2 | C → B | cpu-1m                 |       6.917 |        2.963 |   -3.954 | 0.428 |
|    2 | C → B | sequential-16-ordinary |      12.611 |        6.599 |   -6.012 | 0.523 |
|    3 | B → C | noop-160               |       3.063 |        3.105 |    0.042 | 1.014 |
|    3 | B → C | cpu-100k               |       3.589 |        4.229 |    0.640 | 1.178 |
|    3 | B → C | cpu-1m                 |       4.036 |        4.299 |    0.263 | 1.065 |
|    3 | B → C | sequential-16-ordinary |       7.869 |        9.160 |    1.291 | 1.164 |
|    4 | C → B | noop-160               |       9.229 |        3.637 |   -5.592 | 0.394 |
|    4 | C → B | cpu-100k               |       7.761 |        4.157 |   -3.603 | 0.536 |
|    4 | C → B | cpu-1m                 |       8.405 |        5.517 |   -2.887 | 0.656 |
|    4 | C → B | sequential-16-ordinary |      13.582 |       12.380 |   -1.202 | 0.912 |
|    5 | B → C | noop-160               |      10.952 |        5.199 |   -5.753 | 0.475 |
|    5 | B → C | cpu-100k               |      10.050 |        7.028 |   -3.022 | 0.699 |
|    5 | B → C | cpu-1m                 |      10.688 |        6.838 |   -3.851 | 0.640 |
|    5 | B → C | sequential-16-ordinary |      23.478 |       13.523 |   -9.955 | 0.576 |

The earlier >20% Node median regressions were not reproduced in this longer
check: every paired scenario-median ratio stayed below 1.20. Median paired ratios
were 0.565 for no-op, 0.699 for 100k, 0.656 for one million and 0.912 for ordinary-16.
All cells used one worker leg and zero public waits, with identical result and
tool-call assertions. Median worker-run totals divided by 40 were 3.391 → 2.370,
5.026 → 3.743, 5.634 → 3.691 and 12.136 → 8.924 ms respectively. Ordinary host-wait
totals divided by 40 were 5.059 → 3.730 ms; the CPU/control cases had none.
These overlapping durations remain diagnostics, not exclusive CPU phases.

Process variation was substantial: baseline no-op medians ranged 2.088–10.952 ms,
candidate 2.236–5.199 ms. The check establishes neither Node speed gains nor
statistical equivalence and cannot exclude smaller regressions. No iteration
trace was collected, so warmup transitions or isolated stalls cannot be resolved.
Some per-process p95 values still moved adversely, including 100k
5.086 → 8.102 ms and ordinary-16 9.535 → 13.699 ms in pair three; production tail
latency remains unqualified. The supported performance result is the required
checkpoint reduction in this controlled owner workload, especially QuickJS.
Further work should measure packaged/end-to-end behavior rather than repeat the
same noisy source campaign without a new hypothesis.

One earlier partial run was intentionally cancelled before its candidate arm.
A second attempt lost SSH after baseline Node only (exit 255; remote workload exit
unknown). Both are excluded from these results. The completed fresh campaign
returned exit zero; a later external portal-sync warning did not change the
native successful command/completion receipt. No OOM or idle-timeout cause was
established for the failed connection.

## Codex comparison and replacement direction

Codex's Code Mode is native V8, not a Node bootstrap or QuickJS/WASM guest.
The inspected local source `414782450952a196bbb64b1605a458c2531c47b6` creates a
fresh isolate/context in `codex-rs/code-mode/src/runtime/mod.rs:172-180` and
installs a narrow capability bridge in `runtime/globals.rs:15-45`.

The newer inspected source
[`155dde7ff60b178ec4ba7154b2e48c6071eb5001`](https://github.com/openai/codex/tree/155dde7ff60b178ec4ba7154b2e48c6071eb5001)
uses `codex-rs/code-mode-runtime/src/runtime/mod.rs:187-198`,
`runtime/globals.rs:15-40`, and
`codex-rs/code-mode/src/remote_session/connection.rs:156-169`. It retains a live
isolate across yields inside a separate persistent host process. Connection
startup calls `scrub_non_inheritable_env_vars` before spawning; this is not a claim
that its environment is empty. It removes `console`, `Atomics`, `SharedArrayBuffer` and
`WebAssembly` from guest globals. Direct spawning and environment scrubbing do
not by themselves prove an OS sandbox. The constructors in
`codex-rs/code-mode-runtime/src/service.rs:43-62` set `max_heap_size_bytes` to
`None`; do not copy this as a strict memory model.

A separate-process minimal native-V8 executor is the credible replacement
candidate. It could combine V8 speed with a narrower capability surface and
explicit process-level supervision, but still needs a process memory limit,
protocol/bridge ownership, cancellation, deployment and packaging design.
Embedding another native isolate library in the Gateway would still share its
OS process. Neither alternative has been benchmarked here. Retire QuickJS only
after equivalent isolation, compatibility, memory and end-to-end evidence exists.
Removing the executor also changes explicit QuickJS selection and plugin
availability. Verify release-tag reachability and any required configuration
migration first; silently falling back to Node would change the trust boundary.

## Reproduction and remaining qualification

The measured inputs can be reconstructed from public stack objects without
treating a later main revision as measured:

- Start a clean, task-owned checkout at
  [069613ae61b962c4a0796098edf084c4e78a4972](https://github.com/openclaw/openclaw/commit/069613ae61b962c4a0796098edf084c4e78a4972).
  Its parent is the public baseline `2a37974b97338c9ff354bbc734f7639e2d23ab78`;
  its only changes are the 3.6.3 manifest and lockfile pin. Use Node 24.22.1,
  pinned pnpm 12.15.0 and a qualified frozen install.
- Use the same owner probe from public
  [05c474f67d5fd79331ce1e55eda1d0750c2240a2](https://github.com/openclaw/openclaw/commit/05c474f67d5fd79331ce1e55eda1d0750c2240a2)
  for both arms. Its SHA-256 is
  `aa5013a745c9fca6d780ffb5b36cd333fdb1a255a3e756a6bc625f4d4dbcb8a6`.
- Overlay only the five runtime files listed in Candidate qualification from
  baseline `2a37974b97338c9ff354bbc734f7639e2d23ab78` or public candidate
  [443b2e3ebe0f5255dca6bd531d88641aec99ab4a](https://github.com/openclaw/openclaw/commit/443b2e3ebe0f5255dca6bd531d88641aec99ab4a).
  Those candidate files match all five recorded hashes. The baseline files match
  the historical baseline `53d9e6412c05d1ff315b590c81240d6250b914a7`.

With those objects available in that disposable checkout, select each arm:

```sh
git restore --source=05c474f67d5fd79331ce1e55eda1d0750c2240a2 --worktree -- \
  src/agents/code-mode-engine-owner.perf.test.ts
# Baseline arm; substitute 443b2e3ebe0f5255dca6bd531d88641aec99ab4a for candidate.
git restore --source=2a37974b97338c9ff354bbc734f7639e2d23ab78 --worktree -- \
  extensions/code-mode-quickjs/src/code-mode.worker.ts \
  src/agents/code-mode-controller-source.ts \
  src/agents/code-mode-execution-budget.ts \
  src/agents/code-mode-execution.ts \
  src/agents/code-mode-node.worker.ts
OPENCLAW_CODE_MODE_MEASURE=1 OPENCLAW_CODE_MODE_MEASURE_ROUNDS=8 \
  node scripts/run-vitest.mjs src/agents/code-mode-engine-owner.perf.test.ts -t '^quickjs '
```

Keep the dependency graph and probe fixed while alternating baseline/candidate
and engine processes. This reconstructs the identified measurement inputs, not
the entire historical tree, runner resources or absolute timing.

Subsequent integration onto main preserves its newer actionable store errors and
native diagnostic reconstruction. Those controller/execution files differ from
the measured hashes. Later changes to Node module loading and shared-worker
compilation/retirement also fall outside the frozen inputs. Use current-head CI to qualify the integrated
source separately; the historical performance numbers above are not measurements
of that revision.
Dual-engine capacity-error and forged-store-provenance coverage remains a named
follow-up to upstream's Node store tests; it is not supplied by these timings.

To qualify the current integrated checkout separately from reconstructed arms:

```sh
node scripts/run-vitest.mjs src/agents/code-mode-engine-parity.test.ts
OPENCLAW_CODE_MODE_MEASURE=1 OPENCLAW_CODE_MODE_MEASURE_ROUNDS=8 \
  node scripts/run-vitest.mjs src/agents/code-mode-engine-owner.perf.test.ts -t '^quickjs '
node --import ./scripts/tsx.mjs extensions/code-mode-quickjs/bench/engine-attribution.ts
```

Run the owner probe for Node in a separate process using `-t '^node '`, alternate
the arms, and record exact source/tree, runtime, effective CPU/memory resources,
host load, cold/warm state, flags, sample counts and any failed/retried arm. The
direct executor probe in `scripts/perf/code-mode-engine-measure.ts` bypasses owner
wait policy and is not a substitute for the owner probe.

This investigation does **not** qualify a matched ShellBench campaign, real
model/tool/network behavior, packaged cold startup, Gateway peak RSS, OS
containment, or live adoption. Historical direct-versus-Code Mode scores do not
answer QuickJS-versus-Node. A future ShellBench comparison needs matched source,
model/provider, task subset and seed, concurrency, retry policy and auditable
traces, including accuracy, total calls/tokens and end-to-end latency. Fewer
visible model turns alone is not a win.

The parked ShellBench campaign remains a separate qualification boundary.
