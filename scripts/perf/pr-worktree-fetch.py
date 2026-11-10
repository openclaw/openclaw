#!/usr/bin/env python3
"""Measure missing-commit acquisition in a synthetic blobless partial clone.

python3 scripts/perf/pr-worktree-fetch.py /absolute/new/task-owned/directory
Use --baseline-root and --candidate-root to time checkout_pr_worktree_target
from two trusted source trees instead of the underlying Git commands. Creation,
clone copying and inventories are outside timing. Five counterbalanced A/B pairs
and two A/A pairs use fresh object stores and warm filesystem caches. Default
history approximates a large repository's commit/tree count; unrelated agent DB
and workspace-file scale do not participate in commit negotiation. Pack bytes
measure received compressed objects, not transport framing or physical disk IO.
Native CPU includes Git's local upload-pack server; RSS is peak resident memory,
not cumulative allocation. No network or production data is used.
Use --restore to start shallow, explicitly unshallow, and compare pathspec-file
restore with a negotiated commit fetch followed by lazy blob-only restore.

Acceptance: normal fetch sends haves, reduces new pack bytes by >99%, preserves
the requested checkout, and improves wall/CPU without >20% peak-RSS growth.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import struct
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("--commits", type=int, default=126_357)
parser.add_argument("--tree-depth", type=int, default=7)
parser.add_argument("--pairs", type=int, default=5)
parser.add_argument("--aa-pairs", type=int, default=2)
parser.add_argument("--baseline-root", type=Path)
parser.add_argument("--candidate-root", type=Path)
parser.add_argument("--restore", action="store_true")
options = parser.parse_args()
assert options.commits >= 100 and options.tree_depth >= 1
assert options.pairs >= 1 and options.aa_pairs >= 0
assert bool(options.baseline_root) == bool(options.candidate_root)
assert not (options.restore and options.baseline_root)
root = options.directory.resolve()
root.mkdir()
environment = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0",
                   GIT_CONFIG_PARAMETERS="'gc.auto=0' 'maintenance.auto=false'")
for key in ("GIT_NO_LAZY_FETCH", "GIT_TRACE_PACKET", "GIT_TRACE2_EVENT",
            "OPENCLAW_PR_GIT", "GIT_EXEC", "OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT"):
    environment.pop(key, None)


def git(directory, *args, data=None, extra=None):
    result = subprocess.run(["git", "-C", str(directory), *args], input=data,
                            env=environment | (extra or {}), capture_output=True,
                            check=True)
    return result.stdout.decode().strip()


origin = root / "origin.git"
seed = root / "seed"
git(root, "init", "--bare", "--initial-branch=main", str(origin))
git(origin, "config", "uploadpack.allowFilter", "true")
git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
path = "/".join([f"d{i}" for i in range(options.tree_depth - 1)] + ["file.txt"])
process = subprocess.Popen(["git", "-C", str(origin), "fast-import", "--quiet"],
                           env=environment, stdin=subprocess.PIPE)
assert process.stdin
for index in range(options.commits):
    content = f"synthetic revision {index}\n"
    message = f"Synthetic commit {index}"
    process.stdin.write((
        f"blob\nmark :1\ndata {len(content)}\n{content}\n"
        "commit refs/heads/main\n"
        f"committer Fixture <fixture@example.invalid> {1700000000 + index} +0000\n"
        f"data {len(message)}\n{message}\nM 100644 :1 {path}\n\n"
    ).encode())
process.stdin.close()
assert process.wait() == 0
git(root, "clone", "--filter=blob:none", "--no-checkout",
    *(["--depth=2"] if options.restore else []), origin.as_uri(), str(seed))
if options.restore:
    assert git(seed, "rev-parse", "--is-shallow-repository") == "true"
    git(seed, "fetch", "--unshallow", "--filter=blob:none", "origin")
    assert git(seed, "rev-parse", "--is-shallow-repository") == "false"
git(seed, "checkout", "--detach", "origin/main")
base = git(seed, "rev-parse", "HEAD")
blob = git(origin, "hash-object", "-w", "--stdin", data=b"synthetic pull request\n")
process = subprocess.Popen(["git", "-C", str(origin), "fast-import", "--quiet"],
                           env=environment, stdin=subprocess.PIPE)
assert process.stdin
process.stdin.write((
    "commit refs/pull/42/head\n"
    f"committer Fixture <fixture@example.invalid> {1700000000 + options.commits} +0000\n"
    f"data 17\nSynthetic PR head\nfrom {base}\nM 100644 {blob} {path}\n\n"
).encode())
process.stdin.close()
assert process.wait() == 0
target = git(origin, "rev-parse", "refs/pull/42/head")


def packs(directory):
    return {entry.name: entry.stat().st_size
            for entry in (directory / ".git/objects/pack").glob("*.pack")}


def timed(label, command, cwd, trace):
    receipt = root / f"{label}.time"
    prefix = (["/usr/bin/time", "-l", "-o", str(receipt)] if sys.platform == "darwin"
              else ["/usr/bin/time", "-f", "%e %U %S %M", "-o", str(receipt)])
    start = time.perf_counter()
    result = subprocess.run([*prefix, *command], cwd=cwd,
                            env=environment | {"GIT_TRACE_PACKET": str(trace)},
                            capture_output=True, text=True)
    elapsed = (time.perf_counter() - start) * 1000
    (root / f"{label}.stderr").write_text(result.stderr)
    assert result.returncode == 0, result.stderr
    raw = receipt.read_text()
    if sys.platform == "darwin":
        parsed = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", raw)
        cpu = (float(parsed[2]) + float(parsed[3])) * 1000
        rss = int(re.search(r"(\d+)\s+maximum resident set size", raw)[1])
    else:
        _, user, system, kib = raw.split()
        cpu = (float(user) + float(system)) * 1000
        rss = int(kib) * 1024
    return {"wallMs": elapsed, "cpuMs": cpu, "peakRssBytes": rss}


def run(label, candidate):
    clone = root / label
    shutil.copytree(seed, clone)
    before = packs(clone)
    configuration = (clone / ".git/config").read_bytes()
    checkpoint = clone / ".git/FETCH_HEAD"
    checkpoint.write_text(f"{base}\t\tbranch 'main' of synthetic-origin\n")
    retained_checkpoint = checkpoint.read_bytes()
    trace = root / f"{label}.packet"
    if options.baseline_root:
        selected = (options.candidate_root if candidate else options.baseline_root).resolve()
        command = ["bash", "-c", 'set -euo pipefail; source "$1/scripts/pr-lib/common.sh"; '
                   'source "$1/scripts/pr-lib/worktree.sh"; canonical_repo_root="$PWD"; '
                   'checkout_pr_worktree_target 42 "$2" temp/pr-42', "bench", str(selected), target]
    elif options.restore:
        command = ["bash", "-c", 'set -euo pipefail; '
                   + ('git fetch --no-tags --no-write-fetch-head origin "$1"; '
                      if candidate else '')
                   + 'printf "%s\\0" "$2" | git --literal-pathspecs restore '
                   '--source="$1" --staged --worktree --pathspec-from-file=- '
                   '--pathspec-file-nul', "bench", target, path]
    elif candidate:
        command = ["bash", "-c", 'set -euo pipefail; '
                   'git fetch --no-tags --no-write-fetch-head origin "$1"; '
                   'git fetch --no-tags --no-write-fetch-head origin "$2"; '
                   'GIT_NO_LAZY_FETCH=1 git checkout -B temp/pr-42 "$1"', "bench", target, blob]
    else:
        command = ["git", "checkout", "-B", "temp/pr-42", target]
    result = timed(label, command, clone, trace)
    after = packs(clone)
    additions = [clone / ".git/objects/pack" / name for name in after if name not in before]
    object_count = 0
    for pack in additions:
        with pack.open("rb") as stream:
            magic, version, count = struct.unpack("!4sII", stream.read(12))
            assert magic == b"PACK" and version in (2, 3)
            object_count += count
    packets = trace.read_text()
    wanted = re.findall(r"fetch> want ([0-9a-f]{40})", packets)
    if options.restore:
        assert wanted == [target, blob], wanted
        assert bool(re.search(r"fetch> have ", packets)) == candidate
    result.update(label=label, candidate=candidate, newPacks=len(additions),
                  newPackBytes=sum(pack.stat().st_size for pack in additions),
                  receivedObjects=object_count,
                  havePackets=len(re.findall(r"fetch> have [0-9a-f]{40}", packets)),
                  wants=len(wanted), wantedObjects=wanted,
                  load=os.getloadavg())
    assert git(clone, "rev-parse", "HEAD") == (base if options.restore else target)
    assert git(clone, "rev-parse", "origin/main") == base
    assert (clone / ".git/config").read_bytes() == configuration
    assert checkpoint.read_bytes() == retained_checkpoint
    assert (clone / path).read_text() == "synthetic pull request\n"
    assert git(clone, "write-tree") == git(origin, "rev-parse", f"{target}^{{tree}}")
    assert git(clone, "diff", "--exit-code") == ""
    if not options.restore:
        assert git(clone, "status", "--porcelain") == ""
    shutil.rmtree(clone)
    print(json.dumps(result), flush=True)
    return result


rows = []
for pair in range(options.pairs):
    for candidate in ([False, True] if pair % 2 == 0 else [True, False]):
        rows.append(run(f"ab-{pair}-{'candidate' if candidate else 'baseline'}", candidate))
controls = []
for pair in range(options.aa_pairs):
    for arm in ("a", "a2"):
        controls.append(run(f"aa-{pair}-{arm}", False))


def summary(values):
    result = {}
    for key in ("wallMs", "cpuMs", "peakRssBytes", "newPackBytes", "receivedObjects", "havePackets"):
        series = sorted(row[key] for row in values)
        result[key] = {"median": statistics.median(series), "min": min(series),
                       "max": max(series), "p95": series[min(len(series) - 1, int(len(series) * .95))]}
    return result


report = {"git": git(root, "--version"), "commits": options.commits,
          "trees": options.commits * options.tree_depth,
          "base": base, "target": target, "blob": blob, "rows": rows, "aa": controls,
          "owner": bool(options.baseline_root), "restore": options.restore,
          "ownerHashes": {name: hashlib.sha256((source.resolve() / "scripts/pr-lib/worktree.sh").read_bytes()).hexdigest()
                          for name, source in (("baseline", options.baseline_root),
                                               ("candidate", options.candidate_root)) if source},
          "summary": {"baseline": summary([row for row in rows if not row["candidate"]]),
                      "candidate": summary([row for row in rows if row["candidate"]])}}
(root / "results.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report["summary"], indent=2))
