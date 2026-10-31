"""Native Git missing-blob probe; this does not measure the Gateway/RPC owner.

python3 scripts/perf/checkout-diff-promisor-measure.py --state-dir <new-directory>

Seed small synthetic promisor packs through the committed maintenance fixture.
Compare sessions.diff's combined inventory with metadata-only raw inventory and
the existing PR-stat local-object check. Alternating samples and separate A/A
controls use warm OS caches; trace passes are excluded from latency summaries.
CPU includes native Git children; physical disk bytes and allocation are not
measured. Pack-access traces omit metadata/index reads, so are not IO totals.
"""

import argparse
import json
import os
from pathlib import Path
import resource
import statistics
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--state-dir", type=Path, required=True)
parser.add_argument("--packs", type=int, default=16)
parser.add_argument("--objects-per-pack", type=int, default=16384)
parser.add_argument("--samples", type=int, default=5)
options = parser.parse_args()
assert options.packs >= 16 and options.objects_per_pack >= 1 and options.samples >= 5
assert options.packs * options.objects_per_pack <= 1_048_576, "Keep this probe small"
root = options.state_dir.resolve()
assert not root.exists(), "Use a new task-owned synthetic directory"
subprocess.run([
    "node", str(Path(__file__).with_name("managed-git-maintenance-measure.ts")),
    "--mode", "prepare-midx", "--packs", str(options.packs),
    "--blobs-per-pack", str(options.objects_per_pack), "--state-dir", str(root),
], check=True, stdout=subprocess.PIPE)
repo = root / "repository"
env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
           GIT_NO_LAZY_FETCH="1", GIT_AUTHOR_NAME="Synthetic",
           GIT_AUTHOR_EMAIL="synthetic@example.invalid", GIT_COMMITTER_NAME="Synthetic",
           GIT_COMMITTER_EMAIL="synthetic@example.invalid",
           GIT_AUTHOR_DATE="1700000000 +0000", GIT_COMMITTER_DATE="1700000000 +0000")
for key in ["GIT_TRACE_PACK_ACCESS", "GIT_TRACE2_EVENT"]:
    env.pop(key, None)

def git(args, data=None, extra=None):
    return subprocess.run(["git", "-C", str(repo), *args], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env | (extra or {}))

def checked(args, data=None):
    result = git(args, data)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip().decode()

before_blob = checked(["hash-object", "-w", "--stdin"], b"old synthetic line\n")
after_blob = checked(["hash-object", "-w", "--stdin"], b"new synthetic line\n")
base_tree = checked(["mktree"], f"100644 blob {before_blob}\tchanged.txt\n".encode())
head_tree = checked(["mktree"], f"100644 blob {after_blob}\tchanged.txt\n".encode())
base = checked(["commit-tree", base_tree], b"synthetic base\n")
head = checked(["commit-tree", head_tree, "-p", base], b"synthetic head\n")
checked(["update-ref", "refs/heads/main", head])
pack_dir = repo / ".git/objects/pack"
checked(["pack-objects", str(pack_dir / "pack")],
        ("\n".join([base_tree, head_tree, base, head]) + "\n").encode())
for pack in pack_dir.glob("*.pack"):
    pack.with_suffix(".promisor").touch()
checked(["config", "extensions.partialClone", "origin"])
checked(["config", "remote.origin.promisor", "true"])
checked(["config", "remote.origin.url", str(root / "unavailable-promisor")])
missing_path = repo / ".git/objects" / before_blob[:2] / before_blob[2:]
missing_path.unlink()

common = ["--no-color", "--no-ext-diff", "--no-textconv", "-z", base, head, "--"]
commands = {
    "combined": ["diff", "-M", "--raw", "--numstat", *common],
    "raw-renames": ["diff", "-M", "--raw", *common],
    "raw-local-check": ["-c", "diff.autoRefreshIndex=false", "diff", "--raw", "--no-abbrev", "--no-renames", *common],
}
check_input = f"{before_blob}\n{after_blob}\n".encode()

def measure(name, trace=None):
    extra = {"GIT_TRACE_PACK_ACCESS": str(trace), "GIT_TRACE2_EVENT": str(trace) + ".jsonl"} if trace else None
    previous = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.perf_counter()
    if name == "raw-local-check":
        configuration = git([
            "config", "--get-regexp",
            r"^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$",
        ], extra=extra)
        assert configuration.returncode == 0, "Synthetic fixture must have a promisor remote"
    result = git(commands[name], extra=extra)
    check = git(["cat-file", "--batch-check=%(objectname)"], check_input, extra) if name == "raw-local-check" else None
    elapsed = time.perf_counter() - started
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"elapsed_ms": elapsed * 1000,
            "cpu_ms": ((usage.ru_utime + usage.ru_stime) - (previous.ru_utime + previous.ru_stime)) * 1000,
            "code": result.returncode, "stdout_bytes": len(result.stdout),
            "stderr": result.stderr.decode().strip(),
            "availability": check.stdout.decode().strip() if check else None}

samples = {name: [] for name in commands}
for iteration in range(options.samples):
    for name in (list(commands) if iteration % 2 == 0 else list(reversed(commands))):
        samples[name].append(measure(name))
controls = {name: [measure(name), measure(name)] for name in commands}
traces = {}
for name in commands:
    trace = root / f"{name}.trace"
    result = measure(name, trace)
    lines = trace.read_text().splitlines() if trace.exists() else []
    events = [json.loads(line) for line in Path(str(trace) + ".jsonl").read_text().splitlines()]
    traces[name] = dict(result, pack_accesses=len(lines),
                        distinct_packs=len({line.rsplit(" ", 1)[0].split(" ")[-1] for line in lines}),
                        child_starts=[event.get("argv") for event in events if event.get("event") == "child_start"])

promisors = list(pack_dir.glob("*.promisor"))
for marker in promisors:
    marker.rename(marker.with_suffix(".unmarked"))
unmarked_trace = root / "combined-unmarked.trace"
unmarked = measure("combined", unmarked_trace)
unmarked["pack_accesses"] = len(unmarked_trace.read_text().splitlines()) if unmarked_trace.exists() else 0
for marker in promisors:
    marker.with_suffix(".unmarked").rename(marker)

report = {"git": checked(["--version"]), "packs": len(list(pack_dir.glob("*.pack"))),
          "synthetic_blobs": options.packs * options.objects_per_pack,
          "promisor_packs": len(promisors), "missing_blob": before_blob,
          "samples": samples, "aa": controls, "traces": traces,
          "combined_without_promisor_markers": unmarked,
          "summary": {name: {"median_ms": statistics.median(s["elapsed_ms"] for s in values),
                               "median_cpu_ms": statistics.median(s["cpu_ms"] for s in values)}
                      for name, values in samples.items()}}
(root / "result.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key != "samples"}, indent=2))
