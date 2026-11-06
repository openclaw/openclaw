#!/usr/bin/env python3
"""Measure partial-clone blob fragmentation and bounded delta consolidation.

python3 scripts/perf/worktree-pack-growth-measure.py /absolute/new/task-owned/path

The synthetic history has 32 revisions of one 4 MiB mostly unchanged text file,
seven fetch refspecs, and four linked worktrees. No production data or agent DB
is used: this owner operates on Git objects only. Also measures unrelated random
blobs as a negative control. --workspace-files 62000 adds 1.14 GB of stable tracked
files to every checkout, matching a large workspace without unrelated DB work.
Five counterbalanced A/B pairs and two A/A pairs
exclude fixture creation, copying and inventory. Native timing includes the pack
writer and indexer; RSS is their maximum, not JavaScript heap allocation. Requires
Git and /usr/bin/time on macOS or Linux. Keeps source fixtures and JSON receipts.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("--commits", type=int, default=32)
parser.add_argument("--blob-mib", type=int, default=4)
parser.add_argument("--pairs", type=int, default=5)
parser.add_argument("--aa-pairs", type=int, default=2)
parser.add_argument("--window-memory", default="8m")
parser.add_argument("--workspace-files", type=int, default=0)
parser.add_argument("--extra-packs", type=int, default=0,
                    help="add singleton promisor packs for fetch/inventory scaling proof")
args = parser.parse_args()
if args.commits < 16 or args.blob_mib < 1 or args.pairs < 1:
    parser.error("require at least 16 commits, 1 MiB per blob and one pair")
if args.workspace_files < 0:
    parser.error("workspace-files must not be negative")
if args.extra_packs < 0:
    parser.error("extra-packs must not be negative")
if not re.fullmatch(r"[1-9][0-9]*[kmg]?", args.window_memory):
    parser.error("window-memory must be a positive Git memory size")
root = args.directory.resolve()
root.mkdir()  # Refuse to overwrite an existing fixture.
env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
           GIT_TERMINAL_PROMPT="0",
           GIT_CONFIG_PARAMETERS="'gc.auto=0' 'maintenance.auto=false'")
rows = []


def git(cwd, *argv, input=None, quiet=False):
    result = subprocess.run(["git", "-C", str(cwd), *argv], env=env, input=input,
                            stdout=subprocess.DEVNULL if quiet else subprocess.PIPE,
                            stderr=subprocess.PIPE, check=True)
    return "" if quiet else result.stdout.decode().strip()


def pack_directory(repo):
    return Path(git(repo, "rev-parse", "--absolute-git-dir")) / "objects/pack"


def inventory(repo):
    directory = pack_directory(repo)
    packs = list(directory.glob("*.pack"))
    counts = {}
    for pack in packs:
        index = git(repo, "show-index", input=pack.with_suffix(".idx").read_bytes())
        for line in index.splitlines():
            oid = line.split()[1]
            counts[oid] = counts.get(oid, 0) + 1
    return {"packs": len(packs), "bytes": sum(p.stat().st_size for p in packs),
            "uniqueObjects": len(counts), "duplicateCopies": sum(n - 1 for n in counts.values()),
            "objectSetSha256": hashlib.sha256("\n".join(sorted(counts)).encode()).hexdigest(),
            "promisorPacks": len(list(directory.glob("*.promisor")))}


def emit(row):
    rows.append(row)
    print(json.dumps(row), flush=True)
    (root / "results.json").write_text(json.dumps(rows, indent=2) + "\n")


def timed(label, command, input=None):
    receipt = root / f"{label}.time"
    native = (["/usr/bin/time", "-l", "-o", str(receipt)] if sys.platform == "darwin"
              else ["/usr/bin/time", "-f", "%e %U %S %M", "-o", str(receipt)])
    start = time.perf_counter()
    result = subprocess.run([*native, *command], env=env, input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    wall = (time.perf_counter() - start) * 1000
    raw = receipt.read_text()
    if sys.platform == "darwin":
        parsed = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", raw)
        cpu = (float(parsed[2]) + float(parsed[3])) * 1000
        rss = int(re.search(r"(\d+)\s+maximum resident set size", raw)[1])
    else:
        _, user, system, maximum_rss = raw.split()
        cpu, rss = (float(user) + float(system)) * 1000, int(maximum_rss) * 1024
    return result.stdout, {"wallMs": wall, "cpuMs": cpu, "peakRssBytes": rss}


source = root / "source"
source.mkdir()
git(source, "init", "-b", "main")
for key, value in [("user.name", "Synthetic Fixture"), ("user.email", "fixture@example.invalid"),
                   ("commit.gpgsign", "false"), ("gc.auto", "0"), ("maintenance.auto", "false"),
                   ("uploadpack.allowFilter", "true"), ("uploadpack.allowAnySHA1InWant", "true")]:
    git(source, "config", key, value)
for index in range(args.workspace_files):
    directory = source / "workspace" / f"d{index // 100}"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"f{index}.txt").write_bytes(
        f"synthetic stable workspace file {index}\n".encode().ljust(18 * 1024, b"x"))
if args.workspace_files:
    git(source, "add", "workspace")
rng = random.Random(2214)
lines = [bytes(rng.choices(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=127))
         + b"\n" for _ in range(args.blob_mib * 1024 * 1024 // 128)]
commits = []
for revision in range(args.commits):
    lines[revision % len(lines)] = f"synthetic revision {revision}".encode().ljust(127, b" ") + b"\n"
    (source / "history.txt").write_bytes(b"".join(lines))
    git(source, "add", "history.txt")
    git(source, "commit", "-qm", f"revision {revision}")
    commits.append(git(source, "rev-parse", "HEAD"))
for topic in range(6):
    git(source, "branch", f"topic{topic}", commits[topic * 2])
git(source, "repack", "-ad", "--threads=1")
clone = root / "partial"
git(root, "clone", "--filter=blob:none", "--no-checkout", source.as_uri(), str(clone))
for key, value in [("gc.auto", "0"), ("maintenance.auto", "false")]:
    git(clone, "config", key, value)
for topic in range(6):
    git(clone, "config", "--add", "remote.origin.fetch",
        f"+refs/heads/topic{topic}:refs/remotes/redundant/topic{topic}")
emit({"kind": "fixture", "git": git(root, "--version"), "loadAverage": os.getloadavg(),
      "commits": args.commits, "blobMiB": args.blob_mib,
      "workspaceFiles": args.workspace_files, "trackedFiles": args.workspace_files + 1,
      "logicalBytes": args.workspace_files * 18 * 1024 + args.blob_mib * 1024 * 1024,
      "fullClonePack": inventory(source)})


def operation(label, cwd, *argv, input=None):
    before = inventory(clone)
    _, metrics = timed(label, ["git", "-C", str(cwd), *argv], input=input)
    emit({"kind": "producer", "label": label, "before": before,
          "after": inventory(clone), **metrics})


missing = [line[1:] for line in git(clone, "rev-list", "--objects", "--missing=print",
           "--no-object-names", "--max-count=1", "HEAD").splitlines() if line.startswith("?")]
operation("hydrate", clone, "fetch", "--refetch", "--no-auto-maintenance", "origin",
          "--no-tags", "--no-prune", "--no-write-fetch-head", "--recurse-submodules=no",
          "--stdin", input=("\n".join(missing) + "\n").encode())
for cycle in range(5):
    operation(f"refresh-{cycle}", clone, "fetch", "--no-auto-maintenance",
              "--no-recurse-submodules", "--no-tags", "origin",
              "+refs/heads/main:refs/remotes/origin/main")
for index in range(4):
    linked = root / f"linked-{index}"
    git(clone, "worktree", "add", "--detach", "--no-checkout", str(linked), commits[-1-index])
    operation(f"checkout-{index}", linked, "checkout", "--detach", "HEAD")
linked = root / "linked-0"
operation("diff", linked, "diff", commits[8], commits[12], "--", "history.txt")
operation("blame", linked, "blame", "-L", "1,10", "HEAD", "--", "history.txt")
operation("log", linked, "log", "-p", "--format=%H", "--", "history.txt")
operation("log-repeat", linked, "log", "-p", "--format=%H", "--", "history.txt")

# Copy the production streaming command; the only candidate change is delta search.
pipeline = ('git -C "$1" pack-objects --stdin-packs --stdout --threads=1 "$2" "$3" | '
            'git -C "$1" index-pack --stdin --threads=1 --promisor')


def consolidate(target, label, candidate):
    directory = pack_directory(target)
    selected = [pack.name for pack in directory.glob("*.pack")]
    output, metrics = timed(label, ["/bin/bash", "-o", "pipefail", "-c", pipeline, "fixture",
                            str(target), "--window=10" if candidate else "--window=0",
                            f"--window-memory={args.window_memory}"],
                            input=("\n".join(selected) + "\n").encode())
    oid = output.decode().split()[-1]
    for name in selected:
        if name != f"pack-{oid}.pack":
            for suffix in (".pack", ".idx", ".rev", ".promisor", ".bitmap"):
                (directory / Path(name).with_suffix(suffix)).unlink(missing_ok=True)
    return metrics


unrelated = root / "unrelated"
unrelated.mkdir()
git(unrelated, "init", "--bare")
rng = random.Random(2215)
for index in range(args.commits):
    oid = git(unrelated, "hash-object", "-w", "--stdin",
              input=rng.randbytes(args.blob_mib * 1024 * 1024))
    packed = git(unrelated, "pack-objects", str(unrelated / "objects/pack/pack"),
                 input=(oid + "\n").encode())
    (unrelated / "objects/pack" / f"pack-{packed}.promisor").touch()
for shape, seed in [("similar", clone), ("unrelated", unrelated)]:
    for kind, count in [("ab", args.pairs), ("aa", args.aa_pairs)]:
        for pair in range(count):
            for arm in (["base", "candidate"] if pair % 2 == 0 else ["candidate", "base"]):
                label = f"{shape}-{kind}-{pair}-{arm}"
                target = root / label
                shutil.copytree(seed, target)
                before = inventory(target)
                metrics = consolidate(target, label, kind == "ab" and arm == "candidate")
                after = inventory(target)
                assert before["objectSetSha256"] == after["objectSetSha256"]
                emit({"kind": kind, "shape": shape, "pair": pair, "arm": arm,
                      "before": before, "after": after, **metrics})
                shutil.rmtree(target)

# Separate safety proof: a real linked checkout reads while its source packs retire.
target = root / "reader-proof"
shutil.copytree(clone, target)
shutil.rmtree(target / ".git/worktrees")
linked = root / "reader-linked"
git(target, "worktree", "add", "--detach", str(linked), "HEAD")
reader_code = ('import subprocess,sys\nfor _ in range(100):\n '
               'subprocess.run(["git","-C",sys.argv[1],"cat-file","blob","HEAD:history.txt"],'
               'stdout=subprocess.DEVNULL,check=True)\n')
reader = subprocess.Popen([sys.executable, "-c", reader_code, str(linked)], env=env,
                          stderr=subprocess.PIPE)
try:
    consolidate(target, "reader-consolidate", True)
finally:
    _, stderr = reader.communicate()
assert reader.returncode == 0, stderr
assert git(linked, "rev-parse", "HEAD") == git(target, "rev-parse", "HEAD")
emit({"kind": "concurrent-reader", "reads": 100, "exitCode": reader.returncode,
      "after": inventory(target)})


def prove_pack_scaling():
    target = root / "pack-scaling"
    shutil.copytree(clone, target)

    def sample(label):
        packs = inventory(target)
        for cycle in range(5):
            for operation, command in [
                ("refresh", ["fetch", "--no-auto-maintenance", "--no-recurse-submodules",
                             "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]),
                ("hydration-inventory", ["rev-list", "--objects", "--missing=print",
                                         "--no-object-names", "--max-count=1", "HEAD"]),
            ]:
                _, metrics = timed(f"scaling-{label}-{cycle}-{operation}",
                                   ["git", "-C", str(target), *command])
                emit({"kind": "pack-scaling", "label": label, "operation": operation,
                      "cycle": cycle, "inventory": packs, **metrics})
        assert inventory(target) == packs

    sample("initial")
    directory = pack_directory(target)
    existing = set(directory.glob("*.pack"))
    stream = bytearray()
    for index in range(args.extra_packs):
        payload = f"synthetic singleton pack {index}\n".encode()
        stream.extend(f"blob\ndata {len(payload)}\n".encode() + payload + b"\ncheckpoint\n")
    git(target, "-c", "fastimport.unpackLimit=0", "fast-import", "--quiet", input=bytes(stream))
    assert len(set(directory.glob("*.pack")) - existing) == args.extra_packs
    for pack in set(directory.glob("*.pack")) - existing:
        pack.with_suffix(".promisor").touch()
    sample("fragmented")
    before = inventory(target)
    consolidate(target, "scaling-consolidate", True)
    assert inventory(target)["objectSetSha256"] == before["objectSetSha256"]
    sample("consolidated")


def prove_native_repack():
    target = root / "native-repack"
    shutil.copytree(clone, target)
    shutil.rmtree(target / ".git/worktrees")
    linked = root / "native-linked"
    git(target, "worktree", "add", "--detach", str(linked), "HEAD")
    # Keep one remote promise missing, so the offline repack cannot mask a fetch.
    (source / "future.txt").write_text("synthetic unhydrated future\n")
    git(source, "add", "future.txt")
    git(source, "commit", "-qm", "future promise")
    future = git(source, "rev-parse", "HEAD:future.txt")
    git(target, "fetch", "--filter=blob:none", "--no-auto-maintenance", "--no-tags",
        "--no-write-fetch-head", "origin", "HEAD:refs/remotes/origin/future")
    directory = pack_directory(target)
    kept = None
    unpublished = []
    for keep in [False, True]:
        payload = f"synthetic unpublished object keep={keep}\n".encode()
        oid = git(target, "hash-object", "-w", "--stdin", input=payload)
        packed = git(target, "pack-objects", str(directory / "pack"), input=(oid + "\n").encode())
        (directory.parent / oid[:2] / oid[2:]).unlink()
        unpublished.append(oid)
        if keep:
            kept = directory / f"pack-{packed}.pack"
            kept.with_suffix(".keep").write_text("synthetic retained pack\n")

    def objects():
        return set(git(target, "cat-file", "--batch-all-objects",
                       "--batch-check=%(objectname)").splitlines())

    before = objects()
    assert future not in before
    kept_bytes = kept.read_bytes()
    trace = root / "native-repack-trace.jsonl"
    reader = subprocess.Popen([sys.executable, "-c", reader_code, str(linked)], env=env,
                              stderr=subprocess.PIPE)
    try:
        _, metrics = timed("native-repack", ["env", "GIT_NO_LAZY_FETCH=1", "GIT_ALLOW_PROTOCOL=",
                f"GIT_TRACE2_EVENT={trace}", "git", "-C", str(target),
                "-c", "maintenance.auto=false", "-c", "gc.auto=0", "repack", "-a", "-d",
                "--keep-unreachable", "--no-write-bitmap-index", "--no-pack-kept-objects",
                "--window=10", "--window-memory=8m", "--threads=1"])
    finally:
        _, stderr = reader.communicate()
    assert reader.returncode == 0, stderr
    assert objects() == before
    assert kept.read_bytes() == kept_bytes and kept.with_suffix(".keep").exists()
    assert set(unpublished).issubset(before)
    assert inventory(target)["promisorPacks"] > 0
    for event in map(json.loads, trace.read_text().splitlines()):
        assert not (event.get("event") == "child_start" and "fetch" in event.get("argv", []))
    emit({"kind": "native-repack", "reads": 100, "missingPromisePreserved": future,
          "unpublishedObjectsPreserved": unpublished, "keptPack": kept.name,
          "objectSetSha256": hashlib.sha256("\n".join(sorted(before)).encode()).hexdigest(),
          "after": inventory(target), **metrics})


if args.extra_packs:
    prove_pack_scaling()
prove_native_repack()
