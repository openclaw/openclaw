#!/usr/bin/env python3
"""Compare fresh full clones with shared worktrees and filtered history repair.

python3 scripts/perf/pr-checkout-reuse.py /absolute/new/task-owned/directory

Uses only a local synthetic mirror. Default working set is 62,000 files / 1.14 GB;
640 commits include 128 MiB of unrelated historical blobs. Each operation starts
from an identical shallow blob:none base whose main/topic merge-base is missing.
Five counterbalanced AB pairs plus two AA pairs use warm filesystem caches.
One independent blob:none clone also proves the workspace-scope fallback.

Acceptance: shared worktree downloads <1% of full-clone pack bytes, adds less
storage, and preserves merge-base, log range, rebase and resulting file contents.
CPU and peak RSS include local Git upload-pack children; RSS is not cumulative
allocation. Pack sizes measure received compressed objects, not wire framing.
File sizes/allocated blocks measure retained new storage, not device write IO.
The Git owner never reads agent DBs; no DB-sized fixture or Team data is needed.
Fixture setup, copying, assertions and inventory are excluded from timing.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("--workspace-files", type=int, default=62_000)
parser.add_argument("--history-mib", type=int, default=128)
parser.add_argument("--pairs", type=int, default=5)
parser.add_argument("--aa-pairs", type=int, default=2)
args = parser.parse_args()
assert args.workspace_files >= 0 and args.history_mib >= 16
assert args.pairs >= 1 and args.aa_pairs >= 0
root = args.directory.resolve()
root.mkdir()
env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
           GIT_TERMINAL_PROMPT="0", GIT_AUTHOR_NAME="Synthetic Fixture",
           GIT_AUTHOR_EMAIL="fixture@example.invalid", GIT_COMMITTER_NAME="Synthetic Fixture",
           GIT_COMMITTER_EMAIL="fixture@example.invalid",
           GIT_CONFIG_PARAMETERS="'gc.auto=0' 'maintenance.auto=false' 'commit.gpgsign=false' 'fetch.unpackLimit=1'")
for key in ("GIT_NO_LAZY_FETCH", "GIT_TRACE_PACKET", "GIT_TRACE2_EVENT", "GIT_DIR", "GIT_WORK_TREE"):
    env.pop(key, None)


def git(cwd, *argv, data=None, check=True):
    result = subprocess.run(["git", "-C", str(cwd), *argv], env=env, input=data,
                            capture_output=True, check=check)
    return result.stdout.decode().strip() if check else result


def storage(path):
    logical = allocated = 0
    for directory, _, names in os.walk(path):
        for name in names:
            info = (Path(directory) / name).lstat()
            logical += info.st_size
            allocated += info.st_blocks * 512
    return {"logicalBytes": logical, "allocatedBytes": allocated}


def packs(repo):
    return sum(path.stat().st_size for path in (repo / ".git/objects/pack").glob("*.pack"))


def timed(label, command):
    receipt = root / f"{label}.time"
    native = (["/usr/bin/time", "-l", "-o", str(receipt)] if sys.platform == "darwin"
              else ["/usr/bin/time", "-f", "%e %U %S %M", "-o", str(receipt)])
    start = time.perf_counter()
    result = subprocess.run([*native, *command], env=env, capture_output=True, text=True)
    wall = (time.perf_counter() - start) * 1000
    (root / f"{label}.stderr").write_text(result.stderr)
    assert result.returncode == 0, result.stderr
    raw = receipt.read_text()
    if sys.platform == "darwin":
        parsed = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", raw)
        cpu = (float(parsed[2]) + float(parsed[3])) * 1000
        rss = int(re.search(r"(\d+)\s+maximum resident set size", raw)[1])
    else:
        _, user, system, maximum_rss = raw.split()
        cpu, rss = (float(user) + float(system)) * 1000, int(maximum_rss) * 1024
    return {"wallMs": wall, "cpuMs": cpu, "peakRssBytes": rss}


origin = root / "origin.git"
git(root, "init", "--bare", "--initial-branch=main", str(origin))
git(origin, "config", "uploadpack.allowFilter", "true")
git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
process = subprocess.Popen(["git", "-C", str(origin), "fast-import", "--quiet"],
                           env=env, stdin=subprocess.PIPE)
assert process.stdin
stream = process.stdin
# Fast-import avoids writing a separate 1.14 GB source checkout.
for index in range(args.workspace_files):
    header = f"synthetic stable workspace file {index}\n".encode()
    alphabet = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n "
    translation = bytes(alphabet[value % len(alphabet)] for value in range(256))
    body = hashlib.shake_256(header).digest(4096).translate(translation)
    content = (header + body * 5)[:18 * 1024]
    stream.write(f"blob\nmark :{index + 1}\ndata {len(content)}\n".encode() + content + b"\n")
mark = args.workspace_files + 1
rng = random.Random(2296)
for revision in range(640):
    if revision < 48 and revision % 3 == 0:
        content = rng.randbytes(args.history_mib * 1024 * 1024 // 16)
        stream.write(f"blob\nmark :{mark}\ndata {len(content)}\n".encode() + content + b"\n")
    message = f"main revision {revision}"
    stream.write((f"commit refs/heads/main\nmark :{mark + 1 + revision}\n"
                  f"committer Fixture <fixture@example.invalid> {1700000000 + revision} +0000\n"
                  f"data {len(message)}\n{message}\n").encode())
    if revision == 0:
        for index in range(args.workspace_files):
            stream.write(f"M 100644 :{index + 1} workspace/d{index // 100}/f{index}.txt\n".encode())
    if revision < 48 and revision % 3 == 0:
        stream.write(f"M 100644 :{mark} history.bin\n".encode())
    if revision == 47:
        stream.write(b"D history.bin\n")
    if revision == 639:
        stream.write(b"M 100644 inline main.txt\ndata 12\nmain result\n\n")
    stream.write(b"\n")
    if revision == 631:
        fork_mark = mark + 1 + revision
stream.write(("commit refs/heads/topic\n"
              "committer Fixture <fixture@example.invalid> 1700000100 +0000\n"
              f"data 12\ntopic change\nfrom :{fork_mark}\n"
              "M 100644 inline topic.txt\ndata 13\ntopic result\n\n\n").encode())
stream.close()
assert process.wait() == 0
fork = git(origin, "rev-parse", "main~8")
main = git(origin, "rev-parse", "main")
topic = git(origin, "rev-parse", "topic")
seed = root / "seed"
git(root, "clone", "--depth=2", "--filter=blob:none", "--single-branch", origin.as_uri(), str(seed))
git(seed, "fetch", "--depth=2", "--no-tags", "origin", "refs/heads/topic:refs/remotes/origin/topic")
assert git(seed, "rev-parse", "--is-shallow-repository") == "true"
assert git(seed, "config", "remote.origin.partialclonefilter") == "blob:none"
assert git(seed, "merge-base", "origin/main", "origin/topic", check=False).returncode == 1
reference = git(root, "clone", "--reference", str(seed), "--dissociate", origin.as_uri(),
                str(root / "invalid-reference"), check=False)
assert reference.returncode != 0 and b"shallow" in reference.stderr
seed_packs = packs(seed)
seed_storage = storage(seed)

# All paths are positional parameters, never interpolated shell source.
recipes = {
    "full-clone": '''git clone --single-branch "$1" "$3"
git -C "$3" fetch --no-tags origin refs/heads/topic:refs/remotes/origin/topic
git -C "$3" checkout -b work origin/topic''',
    "shared-worktree": '''git -C "$2" fetch --deepen=256 --filter=blob:none --no-tags --no-auto-maintenance --no-write-fetch-head --refmap= origin "$5" "$6"
git -C "$2" worktree add -b work "$3" origin/topic''',
    "filtered-clone": '''git clone --filter=blob:none --single-branch "$1" "$3"
git -C "$3" fetch --no-tags origin refs/heads/topic:refs/remotes/origin/topic
git -C "$3" checkout -b work origin/topic''',
}
proof = '''test "$(git -C "$3" --no-lazy-fetch merge-base --all HEAD origin/main)" = "$4"
test "$(git -C "$3" log --format=%s origin/main..HEAD)" = 'topic change'
git -C "$3" rebase origin/main'''
rows = []


def run(label, mode):
    trial = root / label
    trial.mkdir()
    base = trial / "base"
    shutil.copytree(seed, base)
    target = trial / "task"
    metrics = timed(label, ["/bin/bash", "-euo", "pipefail", "-c", recipes[mode] + "\n" + proof,
                            "fixture", origin.as_uri(), str(base), str(target), fork, main, topic])
    assert git(target, "rev-parse", "HEAD^") == main
    assert git(target, "log", "--format=%s", "origin/main..HEAD") == "topic change"
    assert (target / "topic.txt").read_text() == "topic result\n"
    assert (target / "main.txt").read_text() == "main result\n"
    assert not (target / "history.bin").exists()
    assert git(target, "status", "--porcelain") == ""
    if mode == "shared-worktree":
        assert git(base, "rev-parse", "--is-shallow-repository") == "true"
        assert git(base, "config", "remote.origin.partialclonefilter") == "blob:none"
        received = packs(base) - seed_packs
    else:
        assert git(target, "rev-parse", "--is-shallow-repository") == "false"
        received = packs(target)
    after = storage(trial)
    row = {"label": label, "mode": mode, **metrics, "receivedPackBytes": received,
           "addedLogicalBytes": after["logicalBytes"] - seed_storage["logicalBytes"],
           "addedAllocatedBytes": after["allocatedBytes"] - seed_storage["allocatedBytes"],
           "loadAverage": os.getloadavg(), "historyProof": "merge-base, log range, rebase, contents passed"}
    rows.append(row)
    print(json.dumps(row), flush=True)
    (root / "rows.json").write_text(json.dumps(rows, indent=2) + "\n")
    shutil.rmtree(trial)
    return row


for pair in range(args.pairs):
    modes = ["full-clone", "shared-worktree"]
    for mode in modes if pair % 2 == 0 else reversed(modes):
        run(f"ab-{pair}-{mode}", mode)
for pair in range(args.aa_pairs):
    for arm in ("a", "a2"):
        run(f"aa-{pair}-{arm}", "full-clone")
run("fallback", "filtered-clone")


def summary(selected):
    result = {}
    for key in ("wallMs", "cpuMs", "peakRssBytes", "receivedPackBytes", "addedLogicalBytes", "addedAllocatedBytes"):
        values = sorted(row[key] for row in selected)
        result[key] = {"median": statistics.median(values), "min": min(values),
                       "max": max(values), "p95": values[min(len(values) - 1, int(len(values) * .95))]}
    return result


report = {"git": git(root, "--version"), "platform": sys.platform,
          "workspaceFiles": args.workspace_files, "workspaceBytes": args.workspace_files * 18 * 1024,
          "historicalBlobBytes": args.history_mib * 1024 * 1024, "commits": 641,
          "base": main, "topic": topic, "fork": fork, "rows": rows,
          "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "summary": {mode: summary([row for row in rows if row["mode"] == mode and row["label"].startswith("ab-")])
                      for mode in ("full-clone", "shared-worktree")}}
(root / "results.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report["summary"], indent=2))
assert report["summary"]["shared-worktree"]["receivedPackBytes"]["median"] < report["summary"]["full-clone"]["receivedPackBytes"]["median"] * .01
assert report["summary"]["shared-worktree"]["addedLogicalBytes"]["median"] < report["summary"]["full-clone"]["addedLogicalBytes"]["median"]
