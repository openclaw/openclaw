# Native sandbox provisioning burst

This driver measures native Podman commands and queue admission, not a full
Gateway turn. It compares 20 simultaneous callers with command concurrency 4 and 8. Two unchanged concurrency-20 controls precede five counterbalanced triplets.
Every sample verifies that all 20 exact container IDs are running. Use
`--mode start --limits 20 2 4` to measure restarting existing stopped containers.

Use an isolated Linux rig with Podman, an existing rootless user and systemd user
manager, Python 3, and btrfs tools. All data must be synthetic. The commands below
create a disposable loop filesystem; set `ROOT` to a new directory on a disk with
at least 4 GiB free and `RUN_USER` to that existing rootless user. Run setup as
root. Never select a production directory or a default container engine store.

```bash
set -euo pipefail
ROOT=/path/to/new/disposable-fixture
RUN_USER=existing-rootless-user
test ! -e "$ROOT"
mkdir -p "$ROOT"/{home,tmp,storage,runroot,hooks,workspace}
truncate -s 3G "$ROOT/btrfs.img"
mkfs.btrfs -q -f "$ROOT/btrfs.img"
mount -o loop,noatime "$ROOT/btrfs.img" "$ROOT/workspace"
btrfs subvolume create "$ROOT/workspace/source"
python3 - "$ROOT/workspace/source" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for i in range(62000):
    directory = root / f"d{i // 1000:02d}"
    directory.mkdir(exist_ok=True)
    (directory / f"f{i:05d}").write_bytes(b"x" * 17742)
PY
for n in $(seq 0 19); do
  btrfs subvolume snapshot "$ROOT/workspace/source" "$ROOT/workspace/session-$n"
done
chown -R "$RUN_USER" "$ROOT"
```

This creates 62,000 files / 1,100,004,000 bytes and 20 separate writable btrfs
snapshots. Content is uniform and compression is disabled; production extent
fragmentation is not modeled. Image storage uses VFS, not the btrfs graph driver.
As the selected user, enter the fixture directory and set `HOME=$ROOT/home`,
`TMPDIR=$ROOT/tmp`, `XDG_RUNTIME_DIR=/run/user/$(id -u)`, and
`DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`. Prepare the image:

```bash
podman --remote=false --root "$ROOT/storage" --runroot "$ROOT/runroot" \
  --storage-driver=vfs --events-backend=file --hooks-dir "$ROOT/hooks" \
  pull docker.io/library/busybox:1.37.0
nice -n 10 ionice -c3 python3 /path/to/scripts/perf/sandbox-container-burst-measure.py \
  "$ROOT" --scope > "$ROOT/provision.jsonl"
```

`--scope` wraps each command with the Gateway's `systemd-run --user --scope`
launcher. Scope mode execs the command in the launcher process; child CPU includes
that launcher and its waited command descendants. Detached conmon/runtime cleanup
is excluded. Python driver CPU is separate. RSS is a cumulative child-process
high-water mark, **not allocation**. This workload does not open an agent database
or measure JavaScript allocation, template preparation, registry admission, setup
commands, or full-Gateway contention. Queue admission affects command concurrency;
the production code is unchanged by this driver.

After retaining the JSONL output, verify the private engine has no containers,
remove its image, and verify its image inventory is empty using the same explicit
engine arguments. As root, delete only the 20 named `session-N` subvolumes and
`source`, unmount `ROOT/workspace`, detach its loop device if still attached, and
remove `ROOT`. A failed run can retain containers: reconcile the captured IDs
before deleting their storage or mounts. Never apply cleanup to a default store.
