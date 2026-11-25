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

Use --persistent --pairs 40 for matched same-policy A/A and counterbalanced A/B
cycles on fixed containers/workspaces. This removes per-sample tree clone/unlink
work; restore the same real dependency-store bytes before every stop. All samples,
including tails, are retained in samples.jsonl with CPU and pressure snapshots.

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



def persistent_matrix(root, source, captures, image, pairs):
    """Matched A/A and A/B cycles without per-sample 62k-file clone/unlink churn."""
    fixtures = {}
    rows = []
    try:
        for slot, arm in [("A0", "A"), ("A1", "A"), ("B", "B")]:
            workspace = root / slot
            run(["cp", "-a", "--reflink=always", str(source), str(workspace)])
            capture = captures[arm]
            argv = list(capture["argv"])
            argv[argv.index("--name") + 1] = f"tmpfs-persistent-{os.getpid()}-{slot.lower()}"
            env = {**capture["env"], "CI": "1"}
            container = engine(*argv, *capture["extraCreateArgs"], "--user", f"{os.getuid()}:{os.getgid()}",
                "--workdir", "/workspace", "-v", f"{workspace}:/workspace:rw",
                *sum((["-e", f"{key}={value}"] for key, value in env.items()), []),
                image, "sleep", "infinity").strip()
            fixtures[slot] = dict(container=container, workspace=workspace, arm=arm, env=env)
            engine("start", container)
            before = mounts(container)
            if arm == "B":
                assert {path: mount["capacityBytes"] for path, mount in before.items()} == {
                    "/tmp": 1024 ** 3, "/var/tmp": 256 * 1024 ** 2,
                    "/tmp/openclaw-deps": 4 * 1024 ** 3, "/run": 256 * 1024 ** 2}
            output = engine("exec", container, "pnpm", "install", "--offline", "--no-frozen-lockfile",
                "--config.optimistic-repeat-install=false", "--store-dir", env["PNPM_CONFIG_STORE_DIR"])
            # Retain real install-created bytes on disk for identical pre-stop occupancy.
            engine("exec", container, "cp", "-a", "/tmp/openclaw-deps/.", "/workspace/store-snapshot")
            dependency = workspace / "node_modules/fixture-dependency/data-0"
            fixtures[slot].update(before=before, installed=mounts(container),
                inode=dependency.stat().st_ino, digest=hashlib.sha256(dependency.read_bytes()).hexdigest(),
                modules=(workspace / "node_modules/.modules.yaml").read_text(),
                labels=json.loads(engine("inspect", "--format", "{{json .Config.Labels}}", container)),
                initialOutput=output)
        # Every pair contains a true same-policy control and a policy comparison.
        # Reverse both treatment and group order on alternating pairs.
        for pair in range(1, pairs + 1):
            groups = [("AA", ["A0", "A1"]), ("AB", ["A0", "B"])]
            if pair % 2 == 0:
                groups = [(group, list(reversed(slots))) for group, slots in reversed(groups)]
            for group, slots in groups:
                for position, slot in enumerate(slots):
                    fixture = fixtures[slot]
                    container, workspace = fixture["container"], fixture["workspace"]
                    engine("exec", container, "cp", "-R", "/workspace/store-snapshot/.", "/tmp/openclaw-deps")
                    occupied = mounts(container)
                    assert occupied == fixture["installed"]
                    pressure_before = {name: (pathlib.Path(f"/proc/pressure/{name}").read_text()
                        if pathlib.Path(f"/proc/pressure/{name}").exists() else None)
                                       for name in ["cpu", "io", "memory"]}
                    def retire():
                        state = json.loads(engine("inspect", "--format", "{{json .State}}", container))
                        assert state["Running"] and not state["Paused"]
                        engine("stop", "--time", "0", container)
                    _, stop = measured(retire)
                    _, restart = measured(lambda: engine("start", container))
                    assert mounts(container) == fixture["before"]
                    group_path = cgroup(container)
                    cpu_before = cgroup_cpu(group_path)
                    output, warm = measured(lambda: engine("exec", container, "pnpm", "install", "--offline",
                        "--frozen-lockfile", "--config.optimistic-repeat-install=false",
                        "--store-dir", fixture["env"]["PNPM_CONFIG_STORE_DIR"]))
                    warm["guestCpuMs"] = cgroup_cpu(group_path) - cpu_before
                    dependency = workspace / "node_modules/fixture-dependency/data-0"
                    assert "recreating" not in output.lower()
                    assert dependency.stat().st_ino == fixture["inode"]
                    assert hashlib.sha256(dependency.read_bytes()).hexdigest() == fixture["digest"]
                    assert (workspace / "node_modules/.modules.yaml").read_text() == fixture["modules"]
                    assert engine("inspect", "--format", "{{.Id}}", container).strip() == container
                    assert json.loads(engine("inspect", "--format", "{{json .Config.Labels}}", container)) == fixture["labels"]
                    row = dict(pair=pair, group=group, position=position, slot=slot, arm=fixture["arm"],
                        container=container, inode=fixture["inode"], occupied=occupied, stop=stop, restart=restart,
                        warm=warm, warmOutput=output, hostLoad=list(os.getloadavg()),
                        pressureBefore=pressure_before, pressureAfter={name: (pathlib.Path(f"/proc/pressure/{name}").read_text()
                        if pathlib.Path(f"/proc/pressure/{name}").exists() else None)
                            for name in pressure_before})
                    rows.append(row)
                    with (root / "samples.jsonl").open("a") as stream:
                        stream.write(json.dumps(row) + "\n")
                    print(json.dumps({key: row[key] for key in ["pair", "group", "slot", "stop", "warm"]}), flush=True)
        summary = {}
        for group, slots in [("AA", ["A0", "A1"]), ("AB", ["A0", "B"])]:
            summary[group] = {}
            for slot in slots:
                selected = [row for row in rows if row["group"] == group and row["slot"] == slot]
                summary[group][slot] = {phase: {metric: {"median": statistics.median(values),
                    "p95": sorted(values)[math.ceil(.95 * len(values)) - 1]}
                    for metric in selected[0][phase] for values in [[row[phase][metric] for row in selected]]}
                    for phase in ["stop", "restart", "warm"]}
        (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        (root / "fixtures.json").write_text(json.dumps({slot: {key: str(value) if isinstance(value, pathlib.Path) else value
            for key, value in fixture.items()} for slot, fixture in fixtures.items()}, indent=2) + "\n")
    finally:
        for fixture in fixtures.values():
            engine("rm", "-f", fixture["container"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "before", "after", "image"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--persistent", action="store_true", help="Matched same-ID A/A and A/B cycles")
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
    if args.persistent:
        persistent_matrix(root, source, captures, args.image, args.pairs)
        return
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
