# Retained continuity owner benchmark

Run only in a fresh disposable Linux container as root, with real `flock`, Node
with `node:sqlite`, Git, GNU time, and btrfs tools. Native service/process
observations come from the controller's existing synthetic fixtures. This is
controller-boundary proof, not a live Gateway or deployment test.

Copy the full candidate controller directory to root-owned `/proof`, and the
pinned baseline `release-lib.mjs` to `/base/release-lib.mjs`. Install the candidate
`gateway-suspension-contract.mjs` at its canonical
`/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs` path. Use mode 0644
for that helper and safe root-owned ancestors. Mount a private disposable btrfs
filesystem at `/scale` with `compress=zstd:1`; a 64 GiB loop image is sufficient.
Create `/scale/tmp` with mode 1777, export `TMPDIR=/scale/tmp`, and create writable
`/lane/scale-results`. Set umask 022. Do not use a live state directory or service.

The fixture materializes a 35.04 GiB SQLite database with compressible zero blobs,
6,000 initial live sessions, and 62,000 workspace files totaling 1.1 GB. The
`post-journal` incident scenario adds 40 live sessions plus 411 original sessions
in a second agent database: 6,451 original witnesses and 6,040 current sessions. It creates one
synthetic database seed under `/scale`; each subsequent sample reflinks that seed
into its own protected inode and creates its own workspace. The native
`session-preservation-witness` owner captures all 6,000 original tuples before any
rotation; the synthetic journal binds that complete witness's descriptor without
changing its creation time. Nothing is copied from production. Fixture preparation,
witness capture, request formation, and cleanup are outside the timed owner command.

From `/proof`, run serially with five interleaved samples for each scenario:

```sh
for scenario in post-journal unchanged; do
  for sample in 1 2 3 4 5; do
    for arm in base candidate; do
      node --import ./test-environment.mjs \
        ./bench/retained-continuity/measure-continuity.mjs \
        "$arm" "$sample" time "$scenario"
    done
  done
  for sample in 1 2; do
    for arm in base candidate; do
      node --import ./test-environment.mjs \
        ./bench/retained-continuity/measure-continuity.mjs \
        "$arm" "$sample" alloc "$scenario"
    done
  done
done
```

`post-journal` captures its original witness through the production owner, then
changes exactly 36 opaque rewrite generations in place with timestamps strictly
after journal creation, rotates five other sessions while retaining their original
windows (four retain an exact generation; one remains empty without a watermark),
and purges 411 sessions under a completed native deletion receipt while
retaining that agent database. The selected pointer and live process cwd still
name the journal candidate. Use merged #195015 as baseline: it must refuse at
strict transcript continuity; the candidate must publish `BUILD_PREPARED` with
6,040 current witnesses. Original journal and witness bytes remain unchanged.
These differing outcomes are a correctness comparison, not a speedup.

`unchanged` must succeed on both arms and serves as the common-path performance
control. Investigate any unexplained increase over 20% in its median wall time,
CPU, or sampled allocation. The optional `rotation` scenario retains the original
window and exact generation across two rotations and must succeed on both arms
when the baseline includes #195015.

The driver measures the actual lock-bearing `retained-repair-build begin` child.
GNU time records user/system CPU and peak RSS. Allocation samples use the Node
inspector heap sampler at 65,536-byte intervals, including objects collected by
minor and major GC. They estimate V8 allocation, not total native allocation or
peak heap; exclude their instrumented durations from timing results. JSON records
include the measured production library SHA-256 and fixture shape. Output also
retains stdout/stderr and GNU time records. The fixture helper's subprocess output
limit is raised for the large witness; controller decisions are unchanged.

After collecting results, remove the task-owned seed and fixtures, unmount the
private btrfs filesystem, delete its loop image, and destroy the container.
