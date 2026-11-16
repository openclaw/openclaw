# Candidate config-contract benchmark

Run this workload in disposable Linux as root, with Node 24.22.1+, Python 3,
`flock`, `strace`, and a loop-mounted btrfs filesystem at `/scale`. Use synthetic
state only. Reuse the retained-continuity benchmark's shape: a real roughly 35 GiB
SQLite database at `/scale/agent.sqlite` with 6,000 session rows and compressible
zero-BLOB padding, plus 62,000 workspace files at `/scale/workspace` totaling
1.1 GB. The shape's size is not a claim of physical compressed allocation.
The driver creates this shape if it is absent; fixture construction stays outside
the timed commands. Start with a fresh four-GiB loop image formatted by
`mkfs.btrfs` and mounted with `compress=zstd:1`.

Build the candidate with the repository build owner. Copy the controller closure
into root-owned `/proof`, keeping all four files together; install its suspension
helper at the canonical path described in the controller README. Pass the actual
candidate build, that controller directory, a fresh synthetic namespace, an output
directory, and the candidate source SHA:

```sh
node /proof/bench/config-contract/measure.mjs \
  /candidate /proof /scale/config-contract-benchmark /evidence FULL_SOURCE_SHA
```

Both arms use the same actual candidate build and hold the canonical fixture lock.
Baseline calls `config validate --json`, as the original controller did; fixed calls
the candidate's config projection worker and pipes its result into the controller's
`config-contract prepare` owner. The namespace uses a synthetic candidate pointer;
this measures config admission, not sealed-tree auditing, live suspension, or a full
systemd deployment. No mocked migration result enters either arm.

Acceptance: a retired Codex key changes from refusal to admission with a receipt
naming exactly that key; the authored config stays byte-identical before the managed
stop. An unknown key remains refused. Unchanged configuration is admitted by both
arms and is the common-path control. Investigate unexplained median wall, CPU, or
sampled-allocation regressions above 20%. Restored admission necessarily does work
that the early refusal omitted; report this as correctness repair cost, not speedup
or deployment downtime.

The fixture starts from an explicitly authored current config, including its
completed Skill Workshop migration marker. Expected inputs are not derived from
the projection under test. The driver runs one warm-up per scenario and arm, then two A/A
sets of five interleaved baseline/fixed samples, each in a fresh process. Python
child resource usage includes the entire shell/process pipeline. Summary JSON has
median, p95, min/max wall time, CPU, RSS, and separate V8 sampled allocations.
Allocation-instrumented and syscall-traced durations never enter timing summaries.
The existing retained-continuity allocation sampler includes collected objects at
64 KiB intervals; it estimates V8 allocation, not exact native or peak allocation.

Separate V8 CPU profiles cover the baseline CLI and both fixed pipeline processes.
Separate `strace` samples assert zero agent-database opens, zero canonical state database write
opens, and zero workspace traversal for the fixed admission path. Read-only shared
state access and workspace plugin-directory metadata probes are counted separately;
they are not database migrations or workspace scans. The existing read-only locator
may write temporary custody databases in its task cache; those are reported separately.
The
output includes the source SHA, worker and library hashes, runtime, and observed
host load. Keep compact results; delete the synthetic namespace, unmount btrfs, and
remove the task-owned image/container after collection.
