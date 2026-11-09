#!/usr/bin/env python3
"""Native rootless Podman tmpfs/setup/stop/resume proof on a synthetic btrfs tree.

Run inside a disposable Linux machine with Podman, a Node/pnpm image, and two
JSON {argv, env, extraCreateArgs} captures from baseline/candidate
resolvePodmanSandboxCreatePolicy and buildSandboxCreateArgs. The
captures must use /tmp, /var/tmp, /tmp/openclaw-deps and builder HOME/XDG/store
settings; this driver does not copy their policy. The native lifecycle operations
complement the production prune owner's reservation/TTL regressions, not replace
them. No agent transcript database is opened by this storage experiment.

Acceptance: five interleaved pairs plus two A/A controls; bounded candidate
mounts; all tmpfs pages released on stop; workspace/dependency bytes and inode
preserved across restart; warm pnpm must not recreate dependencies. Wall/CPU are
reported without claiming a performance win from shrinking the capacity limit.
CPU includes waited CLI children and the container cgroup, separately reported.
Native allocation volume is not measured; tmpfs occupied bytes are read via df.

Example: python3 sandbox-tmpfs-retention-measure.py --root /owned/new-proof
  --before before-allocation.json --after after-allocation.json
  --image localhost/lane2341-node-pnpm:proof

The proof image used Node 26.12.1/bookworm and
`npm install -g pnpm@12.15.0 --allow-scripts=pnpm && pnpm --version`.
pnpm 12 needs its native-binary installation script; --ignore-scripts leaves a
nonexecutable placeholder. Initial synthetic installs create their own lockfile;
the post-restart install uses --frozen-lockfile, offline, with lifecycle scripts.
"""

import argparse
import hashlib
import json
import math
import os
import pathlib
import resource
import shutil
import statistics
import subprocess
import tarfile
import time


def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stdout}\n{result.stderr}")
    return result.stdout


def engine(*args):
    return run(["podman", "--remote=false", *map(str, args)])


def measured(operation):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.monotonic()
    value = operation()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return value, {
        "wallMs": (time.monotonic() - start) * 1000,
        "cliCpuMs": ((after.ru_utime + after.ru_stime) -
                     (before.ru_utime + before.ru_stime)) * 1000,
    }


def mounts(container):
    raw = engine("exec", container, "df", "-B1", "--output=target,size,used",
                 "/tmp", "/var/tmp", "/tmp/openclaw-deps", "/run")
    return {target: {"capacityBytes": int(size), "usedBytes": int(used)}
            for target, size, used in (line.split() for line in raw.splitlines()[1:])}


def cgroup(container):
    pid = int(engine("inspect", "--format", "{{.State.Pid}}", container))
    relative = pathlib.Path(f"/proc/{pid}/cgroup").read_text().split("0::", 1)[1].strip()
    return pathlib.Path("/sys/fs/cgroup") / relative.lstrip("/")


def cgroup_cpu(directory):
    fields = dict(line.split() for line in (directory / "cpu.stat").read_text().splitlines())
    return int(fields["usage_usec"]) / 1000


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "before", "after", "image"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--source", help="Reuse an earlier synthetic source tree")
    args = parser.parse_args()
    assert args.pairs >= 5
    assert os.getuid() != 0, "Use rootless Podman"
    root = pathlib.Path(args.root).resolve()
    root.mkdir()
    assert run(["findmnt", "-n", "-o", "FSTYPE", "-T", str(root)]).strip() == "btrfs"
    source = pathlib.Path(args.source).resolve() if args.source else root / "source"
    if not args.source:
        source.mkdir()
        payload = source / "payload"
        payload.mkdir()
        # Distinct non-sparse files, 1,100,004,000 bytes excluding fixture manifests.
        for index in range(62000):
            (payload / f"{index:05d}").write_bytes(
                (hashlib.sha256(str(index).encode()).digest() * 555)[:17742])
        package = root / "package"
        package.mkdir()
        (package / "package.json").write_text('{"name":"fixture-dependency","version":"1.0.0"}')
        # A real 128-MiB local package avoids registry/network variance inside setup.
        for index in range(8):
            (package / f"data-{index}").write_bytes(os.urandom(16 * 1024 * 1024))
        with tarfile.open(source / "dependency.tgz", "w:gz", compresslevel=1) as archive:
            archive.add(package, arcname="package")
        (source / "package.json").write_text(json.dumps({
            "name": "tmpfs-retention-fixture", "private": True,
            "dependencies": {"fixture-dependency": "file:dependency.tgz"},
            "scripts": {"prepare": "node -e \"require('fs').appendFileSync('setup-runs', 'setup\\n')\""},
        }))
    captures = {arm: json.loads(pathlib.Path(file).read_text())
                for arm, file in [("A", args.before), ("B", args.after)]}
    identity = {
        "kernel": run(["uname", "-a"]).strip(), "podman": engine("version", "--format", "{{.Client.Version}}").strip(),
        "filesystem": "btrfs", "uid": os.getuid(), "files": 62000,
        "payloadBytes": 1100004000, "dependencyPayloadBytes": 128 * 1024 * 1024,
        "dependencyArchiveSha256": hashlib.sha256((source / "dependency.tgz").read_bytes()).hexdigest(),
        "captures": captures, "imageId": engine("image", "inspect", "--format", "{{.Id}}", args.image).strip(),
        "allocation": "Native allocation unmeasured; df occupancy is not allocation volume",
        "agentDatabase": "Not read by this experiment; no padding unrelated database",
    }
    (root / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    rows = []
    series = [("AA1", "A"), ("AA2", "A")]
    for pair in range(1, args.pairs + 1):
        series.extend((f"{arm}{pair}", arm) for arm in ("AB" if pair % 2 else "BA"))
    for label, arm in series:
        workspace = root / label
        run(["cp", "-a", "--reflink=always", str(source), str(workspace)])
        capture = captures[arm]
        argv = list(capture["argv"])
        name = f"openclaw-tmpfs-proof-{os.getpid()}-{label.lower()}"
        argv[argv.index("--name") + 1] = name
        env = {**capture["env"], "CI": "1"}
        command = [*argv, *capture["extraCreateArgs"], "--user", f"{os.getuid()}:{os.getgid()}",
                   "--workdir", "/workspace",
                   "-v", f"{workspace}:/workspace:rw", *sum((["-e", f"{key}={value}"]
                       for key, value in env.items()), []), args.image, "sleep", "infinity"]
        container = engine(*command).strip()
        try:
            engine("start", container)
            group = cgroup(container)
            before = mounts(container)
            cpu_before = cgroup_cpu(group)
            installed, setup = measured(lambda: engine(
                "exec", container, "pnpm", "install", "--offline", "--no-frozen-lockfile",
                "--config.optimistic-repeat-install=false", "--store-dir", env["PNPM_CONFIG_STORE_DIR"]))
            setup["guestCpuMs"] = cgroup_cpu(group) - cpu_before
            after = mounts(container)
            dependency = workspace / "node_modules/fixture-dependency/data-0"
            stat = dependency.stat()
            digest = hashlib.sha256(dependency.read_bytes()).hexdigest()
            assert (workspace / "setup-runs").read_text() == "setup\n"
            if label == "AA2":
                engine("pause", container)
            def retire():
                state = json.loads(engine("inspect", "--format", "{{json .State}}", container))
                if state["Paused"]:
                    engine("unpause", container)
                engine("stop", "--time", "0", container)
            _, stop = measured(retire)
            assert engine("inspect", "--format", "{{.State.Running}}", container).strip() == "false"
            # Rootless engine reclaims the runtime mount namespace at stop.
            group_gone = not group.exists()
            if not group_gone:
                assert (group / "memory.current").read_text().strip() == "0"
            _, restart = measured(lambda: engine("start", container))
            resumed = mounts(container)
            # Podman repopulates image tmpfs files at every start; only the original
            # image contents may return, not install-created scratch/store pages.
            assert resumed == before, (before, resumed)
            assert resumed["/tmp/openclaw-deps"]["usedBytes"] == 0
            assert dependency.stat().st_ino == stat.st_ino
            assert hashlib.sha256(dependency.read_bytes()).hexdigest() == digest
            assert (workspace / "setup-runs").read_text() == "setup\n"
            group = cgroup(container)
            cpu_before = cgroup_cpu(group)
            warm_output, warm = measured(lambda: engine(
                "exec", container, "pnpm", "install", "--offline", "--frozen-lockfile",
                "--config.optimistic-repeat-install=false", "--store-dir", env["PNPM_CONFIG_STORE_DIR"]))
            warm["guestCpuMs"] = cgroup_cpu(group) - cpu_before
            assert "recreating" not in warm_output.lower()
            assert dependency.stat().st_ino == stat.st_ino
            assert (workspace / "setup-runs").read_text() == "setup\nsetup\n"
            if arm == "B":
                assert after["/tmp"]["capacityBytes"] == 1024 ** 3
                assert after["/var/tmp"]["capacityBytes"] == 256 * 1024 ** 2
                assert after["/tmp/openclaw-deps"]["capacityBytes"] == 4 * 1024 ** 3
                assert after["/run"]["capacityBytes"] == 256 * 1024 ** 2
            row = dict(label=label, arm=arm, before=before, after=after, resumed=resumed,
                       setup=setup, stop=stop, restart=restart, warm=warm,
                       stoppedCgroupGone=group_gone, wasPaused=label == "AA2", dependencyPreserved=True,
                       hostLoad=list(os.getloadavg()), installOutput=installed, warmOutput=warm_output)
            rows.append(row)
            (root / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
            print(json.dumps({key: value for key, value in row.items()
                              if key not in ["installOutput", "warmOutput"]}), flush=True)
        finally:
            engine("rm", "-f", container)
            shutil.rmtree(workspace)
    summary = {}
    for arm in "AB":
        selected = [row for row in rows if row["arm"] == arm and not row["label"].startswith("AA")]
        summary[arm] = {phase: {metric: {"median": statistics.median(values),
            "p95": sorted(values)[math.ceil(.95 * len(values)) - 1]}
            for metric in selected[0][phase] for values in [[row[phase][metric] for row in selected]]}
            for phase in ["setup", "stop", "restart", "warm"]}
    (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
