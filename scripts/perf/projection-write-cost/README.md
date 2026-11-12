# Projection writes

This Linux fixture measures dependency reuse after a native btrfs template
snapshot and a synthetic fork checkout. It creates 62,000 source payload files
(1,100,004,000 bytes) and 120 local package archives with 60,000 dependency payload
files (1,064,520,000 bytes). Each payload is distinct; compression is disabled on
the measured filesystem. No production data is required.

Use an exclusively owned directory, a 12-GiB loop-backed btrfs filesystem mounted
at `<root>/mount`, and a 3-GiB tmpfs mounted at `<root>/store`. Create `<root>/tmp`
and `<root>/home`. Write `projection-write-cost-v1` plus a newline to
`<root>/.projection-write-fixture`. The tools refuse other mount types or a missing
marker. Never reuse an operator filesystem or shared dependency directory.

Pass absolute paths for a Node binary and pnpm's `bin/pnpm.mjs`; the recorded
campaign used Node 26.10.0 and pnpm 12.15.0. Run with the repository's pinned
fs-safe dependency available to `clone.mjs`. On a separate host, copy that helper
to a task-owned tooling directory, install the pinned fs-safe version there with
scripts disabled and a task-owned store, and pass `--tool-dir`. Copy the current
`src/agents/sandbox/config-contract.ts` unchanged and pass its path as `--owner`.
The owner module has only erased type imports and runs with native Node.

Every command takes `--root`, `--node`, and `--pnpm`. Run under
`TMPDIR=<root>/tmp nice -n 10 ionice -c3`:

```text
python3 prepare.py <options>
python3 campaign.py <options> cold
python3 campaign.py <options> --owner <module> aadefault1:default aadefault2:default
python3 campaign.py <options> --owner <module> default1:default owner1:owner owner2:owner default2:default default3:default owner3:owner owner4:owner default4:default default5:default owner5:owner
python3 campaign.py <options> summarize
```

Cold template creation is measured once and reported separately. Each branch
then runs native snapshot, real filtered fetch, checkout, frozen offline install,
test, build, and diff. The build writes 16 MiB into disposable dist/.cache paths.
The `default` arm uses pnpm's normal store selection. The `owner` arm imports
`resolveSandboxDependencyStore`, records its source hash/configuration, and passes
the returned environment through install, test, and build. Its fixed container
store pathname maps to the fixture's private tmpfs builder-store namespace.
Both stores start empty; this is identity reuse, not a warmed-store comparison.
Package inode preservation, actual dependency imports, lifecycle output, fork
diff, and template isolation are checked in every sample.

`mismatched` and `matching` arms also support explicitly selected store-path
diagnostics. Keep these separate from the production-default comparison.

Stage metrics include Linux process-attributed written bytes, waited-child CPU,
peak RSS, output blocks, and wall time. Output blocks corroborate the write
counter. RSS is not allocation volume; native allocator volume is unmeasured.
The first production-default pair additionally records synced btrfs subtree
extents. Inspection/sync/cleanup are outside stage metrics. No global cache
eviction occurs. Five-sample p95 is the maximum; A/A controls remain separate.

This exercises the native filesystem operation and real pnpm, not the whole
Gateway, model transport, or container layers. The operations do not open agent
databases. A 35-GiB database, production history/dependency/build sizes, and
production compression or fragmentation are outside this fixture. Shared extent
references must not be reported as independently written bytes.

Preserve compact results, logs, and the manifest, then remove the task-created
template subvolume, unmount the private tmpfs/btrfs mounts, verify loop detachment,
and remove only this owned fixture directory. The driver removes each measured
projection and its task-owned store after recording its result.
