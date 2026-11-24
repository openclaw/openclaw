"""Measure private-checkout Git refreshes on an isolated loop-backed Btrfs volume.

Use only a synthetic repository from sandbox-template-commit-measure.ts --divergent or --lock-change.
Run in a disposable privileged Linux container with networking disabled; mount
only that fixture read-only. See sandbox-template-commit-measure.md for invocation.
"""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import resource
import shutil
import sqlite3
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--fixture", type=Path, required=True)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--lock-change", action="store_true")
parser.add_argument("--database-gib", type=int, default=0)
args = parser.parse_args()
fixture = args.fixture.resolve()
root = args.root.resolve()
output = args.output.resolve()
assert (fixture / ".git").is_dir(), "Use the generated synthetic fixture"
assert root != fixture and fixture not in root.parents
assert not root.exists() or (root.is_dir() and not any(root.iterdir())), "Use an empty root"
assert not output.exists(), "Use a new output directory"
assert output != fixture and fixture not in output.parents
root.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True)
mount = root / "btrfs"
mount.mkdir()
image = root / "disk.img"
home = root / "home"
home.mkdir()
env = {
    "PATH": os.environ["PATH"],
    "HOME": str(home),
    "LC_ALL": "C",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_NO_REPLACE_OBJECTS": "1",
    "GIT_TERMINAL_PROMPT": "0",
}
metrics = []
measurements = []
report = {
    "complete": False,
    "metrics": metrics,
    "measurements": measurements,
    "scope": "Git-only Btrfs probe; optional synthetic storage database, no installer, registry, manifest, projection sync or Gateway",
}


def command(argv, *, data=None, stdin=None, stdout=None, trace=None, check=True):
    result = subprocess.run(
        argv,
        input=data,
        stdin=stdin,
        stdout=stdout if stdout is not None else subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env | ({"GIT_TRACE2_EVENT": str(trace)} if trace else {}),
    )
    if check and result.returncode:
        raise RuntimeError((argv, result.returncode, result.stderr.decode()[-2000:]))
    return result


def git(directory, argv, **kwargs):
    return command(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
         "-C", str(directory), *argv],
        **kwargs,
    )


def git_text(directory, argv):
    return git(directory, argv).stdout.decode().strip()


def measure(arm, phase, run):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.perf_counter()
    result = run()
    elapsed = (time.perf_counter() - started) * 1000
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    row = {
        "arm": arm,
        "phase": phase,
        "wallMs": elapsed,
        "userCpuMs": (after.ru_utime - before.ru_utime) * 1000,
        "systemCpuMs": (after.ru_stime - before.ru_stime) * 1000,
        "maxRssKiB": after.ru_maxrss,
    }
    metrics.append(row)
    print(json.dumps(row), flush=True)
    return result


def pack(source, commit, retained, destination):
    if retained:
        objects = f"--shallow {commit}\n--shallow {retained}\n{commit}\n^{retained}\n"
        flags = ["--revs", "--thin", "--shallow", "--delta-base-offset"]
    else:
        objects = git_text(source, ["rev-list", "--objects", "--no-object-names", f"{commit}^{{tree}}"])
        objects += f"\n{commit}\n"
        flags = []
    with destination.open("wb") as stream:
        git(source, ["pack-objects", "--stdout", *flags], data=objects.encode(), stdout=stream)


def index_pack(directory, pack_file):
    with pack_file.open("rb") as stream:
        git(directory, ["index-pack", "--stdin", "--fix-thin"], stdin=stream)


def file_identity(directory, name):
    stat = (directory / name).stat()
    return {
        "dev": stat.st_dev,
        "ino": stat.st_ino,
        "ctimeNs": stat.st_ctime_ns,
        "mtimeNs": stat.st_mtime_ns,
        "size": stat.st_size,
    }


loop = None
mounted = False
try:
    source = root / "source"
    source.mkdir()
    shutil.copytree(fixture / ".git", source / ".git")
    base = git_text(source, ["rev-parse", "fixture-initial"])
    if args.lock_change:
        heads = {"lock": git_text(source, ["rev-parse", "fixture-lock"])}
        parent = base
        assert git_text(source, ["rev-parse", f"{heads['lock']}^"]) == base
    else:
        heads = {name: git_text(source, ["rev-parse", f"fixture-source-{name}"]) for name in ("one", "two")}
        parent = git_text(source, ["rev-parse", f"{base}^"])
        for head in heads.values():
            assert head != base and git_text(source, ["rev-parse", f"{head}^"]) == parent, (
                "Fixture commits must be siblings; regenerate with --divergent in a new directory"
            )
            assert git_text(source, ["rev-parse", f"{head}:pnpm-lock.yaml"]) == git_text(
                source, ["rev-parse", f"{base}:pnpm-lock.yaml"]
            )
    report.update({
        "base": base,
        "heads": heads,
        "parent": parent,
        "git": command(["git", "--version"]).stdout.decode().strip(),
        "kernel": command(["uname", "-a"]).stdout.decode().strip(),
        "cpuCount": os.cpu_count(),
    })
    command(["truncate", "-s", f"{6 + args.database_gib * 2}G", str(image)])
    loop = command(["losetup", "--find", "--show", str(image)]).stdout.decode().strip()
    command(["mkfs.btrfs", "-f", loop])
    command(["mount", "-t", "btrfs", loop, str(mount)])
    mounted = True
    report["filesystem"] = command(["findmnt", "-n", "-o", "FSTYPE,OPTIONS", str(mount)]).stdout.decode().strip()
    if args.database_gib:
        # Independent synthetic storage load, never production data or schema.
        database = mount / "synthetic-sessions.sqlite"
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, payload BLOB)")
            for row in range(5000):
                db.execute("INSERT INTO sessions VALUES (?, zeroblob(?))", (row, args.database_gib * 1024**3 // 5000))
        report["database"] = {"rows": 5000, "bytes": database.stat().st_size, "allocatedBytes": database.stat().st_blocks * 512}
    seed = mount / "seed"
    command(["btrfs", "subvolume", "create", str(seed)])
    seed_pack = root / "seed.pack"
    measure("seed", "pack", lambda: pack(source, base, None, seed_pack))
    git(seed, ["init", "--quiet", "--template="])
    measure("seed", "indexPack", lambda: index_pack(seed, seed_pack))
    (seed / ".git/shallow").write_text(base + "\n")
    measure("seed", "checkout", lambda: git(
        seed, ["checkout", "--quiet", "-b", "openclaw-template", base],
        trace=output / "seed-checkout.trace2.jsonl",
    ))
    (seed / "node_modules").mkdir()
    dependency = "synthetic retained dependency\n"
    (seed / "node_modules/retained").write_text(dependency)
    if args.lock_change:
        for number in range(5000):
            (seed / "node_modules" / f"dependency-{number}.bin").write_bytes(number.to_bytes(8) + b"d" * (16384 - 8))
    assert git_text(seed, ["status", "--porcelain"]) == ""
    unchanged = "src/group-100/file-10000.txt"
    changed_file = "vendor/dependency/index.js" if args.lock_change else "source.txt"
    obsolete = git_text(seed, ["rev-parse", f"{base}:{changed_file}"])
    sizes = (("lock", "lock"),) if args.lock_change else (("small", "one"), ("large", "two"))
    arms = []
    for control in range(1, 3):
        for size, tag in sizes:
            arms.append((f"{size}-control{control}-baseline", tag, False))
    for pair in range(1, 6):
        for size, tag in sizes:
            for candidate in ((False, True) if pair % 2 else (True, False)):
                variant = "candidate" if candidate else "baseline"
                arms.append((f"{size}-pair{pair}-{variant}", tag, candidate))
    for arm, tag, candidate in arms:
        # Exclude dirty-seed flush and preceding sample transactions from the pair.
        command(["btrfs", "filesystem", "sync", str(mount)])
        commit = heads[tag]
        target = mount / arm
        pack_file = root / f"{arm}.pack"
        load_before = Path("/proc/loadavg").read_text().strip()
        started = time.perf_counter()
        retained = not args.lock_change or candidate
        if retained:
            measure(arm, "snapshot", lambda: command([
                "btrfs", "subvolume", "snapshot", str(seed), str(target),
            ]))
        else:
            command(["btrfs", "subvolume", "create", str(target)])
            git(target, ["init", "--quiet", "--template="])
        identity = {"source": file_identity(seed, unchanged), "snapshot": file_identity(target, unchanged) if retained else None}
        measure(arm, "pack", lambda: pack(source, commit, base if retained else None, pack_file))
        measure(arm, "indexPack", lambda: index_pack(target, pack_file))
        with (target / ".git/shallow").open("a") as stream:
            stream.write(commit + "\n")
        # Read the exited child's counters before reaping; no tracing on a live host.
        checkout_started = time.perf_counter()
        pid = os.fork()
        if pid == 0:
            os.execvpe("git", ["git", "-C", str(target), "checkout", "--quiet", "-B" if retained else "-b", "openclaw-template", commit], env | {"GIT_TRACE2_EVENT": str(output / f"{arm}-checkout.trace2.jsonl")})
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
        io = {key: int(value) for key, value in (line.split(": ") for line in Path(f"/proc/{pid}/io").read_text().splitlines())}
        _, exit_status, usage = os.wait4(pid, 0)
        assert os.waitstatus_to_exitcode(exit_status) == 0
        metrics.append({"arm": arm, "phase": "checkout", "wallMs": (time.perf_counter() - checkout_started) * 1000, "userCpuMs": usage.ru_utime * 1000, "systemCpuMs": usage.ru_stime * 1000, "io": io})
        if retained:
            measure(arm, "reflogExpire", lambda: git(target, ["reflog", "expire", "--expire=all", "--all"]))
            measure(arm, "repack", lambda: git(
                target, ["repack", "-ad", *(["--window=0"] if candidate or args.lock_change else [])],
                trace=output / f"{arm}-repack.trace2.jsonl",
            ))
        (target / ".git/shallow").write_text(commit + "\n")
        critical_ms = (time.perf_counter() - started) * 1000
        assert git_text(target, ["rev-parse", "HEAD"]) == commit
        assert git_text(target, ["diff", "--name-only", commit, "--"]) == ""
        validated = measure(arm, "validate", lambda: git(
            target, ["status", "--porcelain"], trace=output / f"{arm}-validate.trace2.jsonl",
        ))
        assert not validated.stdout.strip()
        git(target, ["fsck", "--full"])
        for oid in (base, obsolete):
            assert git(target, ["cat-file", "-e", oid], check=False).returncode != 0, (
                "Obsolete object survived", oid
            )
        if retained:
            assert (target / "node_modules/retained").read_text() == dependency
            assert file_identity(target, unchanged) == identity["snapshot"]
        assert git_text(seed, ["rev-parse", "HEAD"]) == base
        assert git_text(seed, ["status", "--porcelain"]) == ""
        assert (target / "source.txt").read_bytes() == git(source, ["show", f"{commit}:source.txt"]).stdout
        scans = []
        for trace in output.glob(f"{arm}-*.trace2.jsonl"):
            for line in trace.read_text().splitlines():
                event = json.loads(line)
                if "refresh/sum_" in event.get("key", "") or "writeout" in event.get("key", ""):
                    scans.append({"file": trace.name, "key": event["key"], "value": event["value"]})
        dependency_sharing = None
        if retained and args.lock_change:
            command(["btrfs", "filesystem", "sync", str(mount)])
            dependency_sharing = command(["btrfs", "filesystem", "du", "--raw", "-s", str(seed / "node_modules"), str(target / "node_modules")]).stdout.decode()
        row = {
            "dependencySharing": dependency_sharing,
            "arm": arm,
            "commit": commit,
            "changedPaths": len(git_text(source, [
                "diff-tree", "--no-commit-id", "-r", "--no-renames", "--name-only", base, commit,
            ]).splitlines()),
            "criticalMs": critical_ms,
            "identity": identity,
            "traceRefresh": scans,
            "packBytes": sum(file.stat().st_size for file in (target / ".git/objects/pack").iterdir()
                             if file.suffix in (".pack", ".idx")),
            "loadBefore": load_before,
            "loadAfter": Path("/proc/loadavg").read_text().strip(),
        }
        measurements.append(row)
        print(json.dumps(row), flush=True)
        command(["btrfs", "subvolume", "delete", str(target)])
    report["complete"] = True
finally:
    try:
        (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    finally:
        try:
            if mounted:
                command(["umount", str(mount)])
        finally:
            if loop:
                command(["losetup", "-d", loop])
