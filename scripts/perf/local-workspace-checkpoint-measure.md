# Native checkpoint pause comparison

## Ordinary reconciliation

Use `--mode reconcile --reconcile-target canonical` to export guest changes through
`withLocalWorkspaceProjection(... synchronize("canonical"))`. Select `projection`
to import host changes. Each request changes existing files, invokes that real
owner once, verifies all changed bytes on both sides and checks a subsequent native
guest read. The native guest uses the host workspace owner's UID/GID, so private
imported files remain readable without adding DAC capabilities or changing file
permissions. `--reconcile-changed-files 20000` exercises a substantial admitted delta
inside a 62,000-file/1.1 GB workspace; its files retain their original size. The
synthetic repeated text is compressible and is not an incident-content replay.

The native engine, isolated fixture, source freezing, cleanup accounting and
profiling instructions below apply unchanged. For example, after fixture seeding
and subvolume qualification:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-checkpoint-measure.ts \
  --mode reconcile --reconcile-target canonical --reconcile-changed-files 20000 \
  --native-turns --sandbox-backend podman \
  --guest-image docker.io/library/node:24.22.1-trixie \
  --output /owned-btrfs/reconcile --reuse-fixture --files 62000 --file-bytes 17742 \
  --transcript-mib 12288 --requests 1 --burst 1 --report export-A1.json
```

Freeze the entire baseline and candidate source with `--freeze-source`, then run
the same driver using `--source-root`; this includes the worker implementation.
Measure export and import separately, with two fresh-process baseline controls
followed by five counterbalanced pairs. The acceptance rule is identical accepted
bytes, no remaining pause during staging/patch preparation, reduced paused time,
and no unexplained 20% regression in total owner time, CPU or allocation. The
`finalizationDistributionMs` field is the synchronization owner time; the command
field additionally includes synthetic fixture mutation. Phase durations overlap.
Compare `operationPauseDistributionMs` (all frozen intervals summed per owner call)
and `operationMaxPauseDistributionMs` (the longest continuous interval per call).
Each raw finalization records both. Per-interval percentiles alone are misleading
when the two revisions pause a different number of times.
An engine seam run qualifies owner ordering only, not native freeze latency.

`local-workspace-checkpoint-measure.ts --mode turn-loop --native-turns` runs the
real checkpoint owner against a native Podman guest. Use a disposable Linux rig,
a task-private Podman store, and a local Node guest image. Put the output on btrfs
to qualify btrfs behavior. This does not run a model or copy production data.

Seed once using the baseline source:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-checkpoint-measure.ts \
  --mode turn-loop --native-turns --sandbox-backend podman \
  --guest-image docker.io/library/node:24.22.1-trixie --all-mutating \
  --output /owned-btrfs/checkpoint --files 62000 --file-bytes 17742 \
  --transcript-mib 12288 --requests 1 --burst 1 --report seed.json
```

The transcript option counts logical message text. Current schema/index overhead
turns 12 GiB of logical text into roughly 35 GiB of database; record the actual
`agentDatabaseBytes` result and qualify available disk before seeding.

Use identical baseline and candidate source copies with the same benchmark and
runtime dependencies. Add `--reuse-fixture` and a distinct `--report` for each
fresh process. Run two baseline controls, then at least five counterbalanced
baseline/candidate pairs serially. The seed run and startup are outside the warm
comparison. Never run separate arms or fixture writers concurrently.

Each measured turn has ten actual guest commands. `--all-mutating` changes every
command; omitting it retains two writes and eight unchanged checkpoints. Every
write must appear in canonical storage and the next guest read before the next
command begins. Finalization remains awaited. Pause samples run from successful
pause invocation through successful unpause return and conservatively include
engine CLI overhead. Command latency includes guest execution and finalization;
the subsequent correctness read is excluded.

The native driver acquires the existing reconciliation lease after warmup and
after the measured burst, then awaits outstanding native removal operations
observed by its phase instrumentation. This settles cleanup after canonical
acceptance. `cleanupSettlementMs` reports the final tail separately;
total CPU and allocation include it, while individual command latency does not.
Apply the same driver to every source revision so deferred cleanup cannot make
the candidate's total work disappear from the comparison.
On btrfs, this also performs `syncfs` and waits for `btrfs subvolume sync` after
the burst. The explicit flush avoids waiting for the periodic transaction
commit timer. Native
subvolume deletion delegates extent retirement to kernel threads, which can sit
outside the rig's CPU cgroup. `hostCpuMs` therefore reports `/proc/stat` deltas
for the whole Linux VM, including that work and unrelated daemon activity. Use
the identical-code controls to assess noise; do not describe cgroup CPU alone
as complete kernel-cleanup accounting. The final settlement may include the
sync command's polling interval and is separate from command latency.

To measure unprivileged filesystem operations, run Node as the workspace owner
with no effective capabilities. A task-private rootful Podman API socket can
control the real guest independently; record that engine placement rather than
calling it rootless-engine proof. Do not mount an operator or production socket.
The kernel settlement observer needs privilege for its B-tree query. In another
terminal inside the disposable rig, start the narrowly scoped observer as root:

```sh
python3 scripts/perf/local-workspace-checkpoint-settlement.py \
  --root /owned-btrfs --socket /owned-proof/settlement.sock
```

The root directory must belong to the measured user. The observer creates a
mode-0600 socket for that owner and accepts only a constant settlement request;
it cannot receive a path or command. Add
`--settlement-socket /owned-proof/settlement.sock` to every measurement arm.
Reports record Node's UID and effective capabilities. Snapshot creation and
removal still run as that unprivileged user; only the private engine and final
measurement observer are privileged. Stop the observer after the comparison.

Reports include raw pause and command samples, median/p95/max, main-process CPU,
main-isolate allocation, source hashes, host load, and owner phases. The manifest
phase includes worker dispatch; `withStagedWorkerWorkspaceManifest` contains
`applyStagedWorkerWorkspace`, so those timings overlap. Process CPU excludes child
Git and container processes. Native Linux runs also report the measured-window
`cpu.stat` usage delta for the rig's cgroup and descendants, including Node
workers, native helpers, Git, Podman, and the guest. Use an exclusively owned
cgroup; the report records its namespace membership and CPU limit. Main-isolate
allocation excludes workers and children and requires a runtime exposing V8's
`total_allocated_bytes` counter, such as Node 26.12.1.

Run a separate `--instrument allocation` pass per source for sampled allocation
and a CPU profile saved beside the report as `<report>.cpuprofile`. Native allocation
passes also sample worker heap counters outside the CPU/latency window and report
matched-thread allocation deltas, worker starts/exits, and unavailable or unmatched
samples. Exited workers are not silently counted as zero allocation. Do not compare
instrumented timings against the plain timing arms. Report aggregate process and
main-thread CPU separately, and retain raw samples so phase overlap and outliers
remain inspectable.

For atomic-capture comparisons, verify that the projection itself is a btrfs
subvolume (`stat` reports inode 256 and `btrfs subvolume show` succeeds). Merely
placing the fixture on btrfs leaves an ordinary projection directory. With all
fixture processes stopped, rename that directory to a task-owned backup, call
`nativeWorktreeFilesystem.createSource(projection, { commitGuard: () => {} })`
from a fixture setup script, then populate it with
`cp -a --reflink=always backup/. projection/`. Retain the backup until proof is
complete. The normal initialization and warmup refresh fingerprints before
measurement. Use this same projection sequentially for both sources, two fresh
A/A controls, and five counterbalanced pairs. Native filesystem phases report
`copy`, `remove`, and `probe` separately; source-mode helper startup is included.

Source-mode native helpers can spawn an esbuild child. The rig needs a reaping
init (`docker run --init`) because the production owner requires process-tree
extinction before accepting a native helper's result. In an existing exclusively
owned rig whose PID 1 does not reap, run every comparison arm through this small
Linux subreaper; do not bypass the production extinction guard:

```python
import ctypes, os, signal, subprocess, sys
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
child = subprocess.Popen(sys.argv[1:], start_new_session=True)
for signo in (signal.SIGINT, signal.SIGTERM):
    signal.signal(signo, lambda sig, frame: os.killpg(child.pid, sig))
result = None
while True:
    try:
        pid, code = os.waitpid(-1, 0)
    except ChildProcessError:
        break
    if pid == child.pid:
        result = os.waitstatus_to_exitcode(code)
sys.exit(result if result is not None and result >= 0 else 128 - (result or 0))
```

Invoke it as `python3 subreaper.py node --expose-gc --import ./scripts/tsx.mjs ...`.
Keep stalled or aborted arms as failed observations with their last completed
phase and observed paused interval. Diagnose and record the failure before
continuing; do not silently replace it with a successful retry.

On normal completion, the driver removes only its named guest and registry entry. After
retaining reports, remove the task-owned synthetic fixture and its private engine
storage, unmount the private btrfs filesystem, and remove the rig through its
owner. Never apply cleanup to a default container store or production state.

## Snapshot feasibility probe

Run this only inside an exclusively owned Linux rig. Its Podman wrapper must bind
a private store. The commands below create a private loop filesystem; replace
`/owned-probe` with a new task-owned directory. The image must already be local.

```sh
mkdir /owned-probe
truncate -s 8G /owned-probe/filesystem.img
mkdir /owned-probe/mount
mkfs.btrfs -q -f /owned-probe/filesystem.img
mount -o loop,noatime /owned-probe/filesystem.img /owned-probe/mount
python3 - /owned-probe/mount <<'PY'
import json, os, pathlib, resource, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
source = root / 'source'
subprocess.run(['btrfs', 'subvolume', 'create', str(source)], check=True)
for i in range(62000):
    directory = source / f'd{i // 1000:02}'
    directory.mkdir(exist_ok=True)
    (directory / f'f{i:05}').write_bytes(b'x' * 17742)
print(json.dumps({'files': 62000, 'bytes': 1100004000, 'load': os.getloadavg()}))
for i in range(12):
    (source / 'd00/f00000').write_bytes(f'mutation {i}'.encode().ljust(17742, b'x'))
    target = root / f'capture-{i}'
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.perf_counter()
    subprocess.run(['btrfs', 'subvolume', 'snapshot', str(source), str(target)],
                   check=True, stdout=subprocess.DEVNULL)
    captured = time.perf_counter()
    original, copied = (p.stat() for p in (source / 'd00/f00000', target / 'd00/f00000'))
    command = (['rm', '-rf', str(target)] if i % 2 else
               ['btrfs', 'subvolume', 'delete', str(target)])
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    done = time.perf_counter()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    print(json.dumps({
        'control': i < 2, 'sample': i,
        'createMs': 1000 * (captured - start), 'removeMs': 1000 * (done - captured),
        'remove': 'rm-rf' if i % 2 else 'subvolume-delete',
        'childCpuMs': 1000 * (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime),
        'sourceIdentity': [original.st_dev, original.st_ino, original.st_ctime_ns],
        'snapshotIdentity': [copied.st_dev, copied.st_ino, copied.st_ctime_ns],
    }), flush=True)
PY
```

Keep the first post-seed snapshot separate from warm samples: pending data
writeback can dominate its latency. Run this probe without a simultaneous source
build or database seed if interpreting latency. Recursive removal and native
subvolume deletion do different amounts of work.

A writable guest can create nested subvolumes without added capabilities. On an
ARM64 Debian rig, the following uses the rig's existing btrfs executable and
libraries in a read-only mount so the guest image needs no package installation:

```sh
podman run --detach --name checkpoint-subvolume-probe \
  --cap-drop ALL --security-opt no-new-privileges --network none \
  --mount type=bind,source=/owned-probe/mount/source,target=/workspace \
  --mount type=bind,source=/usr,target=/host-usr,ro \
  docker.io/library/node:24.22.1-trixie sleep infinity
podman exec checkpoint-subvolume-probe /host-usr/lib/ld-linux-aarch64.so.1 \
  --library-path /host-usr/lib/aarch64-linux-gnu /host-usr/bin/btrfs \
  subvolume create /workspace/nested
podman exec checkpoint-subvolume-probe sh -c 'printf guest-data > /workspace/nested/data'
btrfs subvolume snapshot /owned-probe/mount/source /owned-probe/mount/nested-capture
test -f /owned-probe/mount/source/nested/data
test ! -e /owned-probe/mount/nested-capture/nested/data
podman rm --force checkpoint-subvolume-probe
```

The same omission occurs through the existing `@openclaw/fs-safe` tree-clone
primitive used by the template backend. From the installed source checkout:

```sh
node --input-type=module -e '
import { copyTree, probeTreeClone } from "@openclaw/fs-safe/copy";
import fs from "node:fs";
console.log(probeTreeClone("/owned-probe/mount"));
await copyTree("/owned-probe/mount/source", "/owned-probe/mount/native-capture", { clone: "always" });
console.log({
  original: fs.existsSync("/owned-probe/mount/source/nested/data"),
  captured: fs.existsSync("/owned-probe/mount/native-capture/nested/data"),
});
'
```

The assertions expose the consistency hazard: a parent subvolume snapshot
omits the nested subvolume's contents. A checkpoint cannot interpret that empty
snapshot directory as a guest deletion. Snapshot device identity also differs
from the source despite preserved inode and ctime, affecting fingerprint reuse.
After retaining output, delete only the named snapshots and nested/source
subvolumes, unmount this loop filesystem, and remove its task-owned image.

## Dirty-writeback diagnostic

After the command comparison, run the separate synthetic primitive probe on a
new directory on the private btrfs mount, with `btrfs-progs` and `strace` present:

```sh
python3 scripts/perf/local-workspace-snapshot-writeback.py \
  --root /owned-btrfs/writeback-probe > writeback.jsonl
```

It seeds 62,000 files/1.1 GB, then compares snapshots with and without explicit
pre-capture `syncfs`. Steady samples write 1.7 GB/hour in five-second intervals;
separate burst samples rewrite the whole tree immediately before capture. Keep
those regimes separate: an hourly average does not describe burst size. The
probe retains syscall timings beside the report and verifies snapshot isolation.
`Dirty`/`Writeback` are whole-kernel counters, not private-cgroup metrics. Snapshot
timings include `strace` overhead and qualify the primitive, not command latency.
The probe removes its named source and snapshots; retain the small trace files
with the report, then remove that task-owned probe directory.
