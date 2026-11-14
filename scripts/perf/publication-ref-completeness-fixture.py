#!/usr/bin/env python3
"""Measure publication fetch completeness against a synthetic fragmented clone.

Usage: python3 scripts/perf/publication-ref-completeness-fixture.py <new-root>
Requires macOS for native /usr/bin/time -l CPU/RSS receipts. Uses only file:// Git.
Creates 13,536 refs, 1,609 packs, 263,693 packed objects, two shallow roots,
blob:none, and three stale commit-graph layers. The 13,180 synthetic branch tips
have 20 commits each, distributed across packs to exercise object lookup/walking.
Tags are lightweight; this does not reproduce 800M objects or linked worktrees.

Compares MIDX, graph refresh, disposable ref pruning, and fresh staging metadata
with default alternates, suppressed alternate refs, or a shared object directory.
Five native fetch samples per arm; alternating MIDX/no-MIDX controls expose drift.
Staging init/cleanup are outside native fetch timing; the publication owner harness
measures those costs separately. Trace2 phases overlap and must not be summed.
Acceptance: fewer completeness reads, preserved ancestry/refs/shallow boundaries,
unchanged acquired objects; report CPU/RSS regressions and host/scale limitations.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

assert sys.platform == "darwin", "Native CPU/RSS receipts require macOS time -l"
assert len(sys.argv) == 2, "Pass a fresh disposable root directory"
root = Path(sys.argv[1]).resolve()
root.mkdir()
repo = root / "base"
origin = root / "origin.git"
env = dict(
    os.environ,
    GIT_CONFIG_GLOBAL=os.devnull,
    GIT_CONFIG_NOSYSTEM="1",
    GIT_NO_LAZY_FETCH="1",
    GIT_ALLOW_PROTOCOL="file",
    GIT_AUTHOR_NAME="Fixture",
    GIT_AUTHOR_EMAIL="fixture@example.invalid",
    GIT_COMMITTER_NAME="Fixture",
    GIT_COMMITTER_EMAIL="fixture@example.invalid",
    GIT_AUTHOR_DATE="1700000000 +0000",
    GIT_COMMITTER_DATE="1700000000 +0000",
)


def run(cwd, args, input=None, check=True, extra=None):
    return subprocess.run(
        ["git", "-C", str(cwd), *args], input=input, text=True,
        capture_output=True, env=dict(env, **(extra or {})), check=check,
    )


def git(cwd, *args, input=None, extra=None):
    return run(cwd, args, input=input, extra=extra).stdout.strip()


def log(value):
    print(json.dumps(value), flush=True)


git(root, "init", "--bare", "--initial-branch=main", str(origin))
for key, value in [("uploadpack.allowFilter", "true"),
                   ("uploadpack.allowAnySHA1InWant", "true"), ("gc.auto", "0")]:
    git(origin, "config", key, value)
blob = git(origin, "hash-object", "-w", "--stdin", input="synthetic base\n")
tree = git(origin, "mktree", input=f"100644 blob {blob}\tfile.txt\n")
base = git(origin, "commit-tree", tree, input="base\n")
git(origin, "update-ref", "refs/heads/main", base)
git(root, "clone", "--filter=blob:none", "--no-checkout", origin.as_uri(), str(repo))
for key, value in [("gc.auto", "0"), ("gc.autoPackLimit", "0"),
                   ("maintenance.auto", "false")]:
    git(repo, "config", key, value)
second_root = git(repo, "commit-tree", tree, input="second root\n")
git(repo, "update-ref", "refs/heads/second-root", second_root)
parent = second_root
for layer in range(3):
    for index in range(30):
        parent = git(repo, "commit-tree", tree, "-p", parent,
                     input=f"graph {layer} {index}\n")
    git(repo, "update-ref", "refs/heads/graph", parent)
    git(repo, "commit-graph", "write", "--reachable", "--split=no-merge")

# Write graphs before adding the many local histories and shallow boundaries.
process = subprocess.Popen(["git", "-C", str(repo), "fast-import", "--quiet"],
                           stdin=subprocess.PIPE, env=env)
assert process.stdin is not None
for index in range(13_180):
    namespace = (f"refs/heads/session-{index}" if index < 3164 else
                 f"refs/remotes/session/branch-{index}" if index < 8485 else
                 f"refs/openclaw/snapshot-{index}")
    commits = []
    for step in range(20):
        message = f"branch {index} commit {step}"
        commits.append(
            f"commit {namespace}\n"
            f"committer Fixture <fixture@example.invalid> {1800000000 + step} +0000\n"
            f"data {len(message)}\n{message}\n"
            + (f"from {base}\n" if step == 0 else "") + "\n"
        )
    process.stdin.write("".join(commits).encode())
process.stdin.close()
assert process.wait() == 0
objects = git(repo, "rev-list", "--all", "--objects", "--missing=allow-any",
              "--no-object-names").splitlines()
object_directory = repo / ".git/objects"
packs = object_directory / "pack"
original_packs = set(packs.iterdir())
for index in range(1609):
    packed = git(repo, "pack-objects", "--window=0", "--threads=1", str(packs / "pack"),
                 input="\n".join(objects[index::1609]) + "\n")
    (packs / f"pack-{packed}.promisor").touch()
for entry in original_packs:
    entry.unlink()
for index in range(321):
    git(repo, "update-ref", f"refs/tags/tag-{index}", base)
for index in range(15):
    git(repo, "update-ref", f"refs/fixture/trees-{index}", tree)
    ref_blob = git(repo, "hash-object", "-w", "--stdin", input=f"ref blob {index}\n")
    git(repo, "update-ref", f"refs/fixture/blobs-{index}", ref_blob)
git(repo, "pack-refs", "--all")
shallow_path = repo / ".git/shallow"
shallow_path.write_text(base + "\n" + second_root + "\n")
new_blob = git(origin, "hash-object", "-w", "--stdin", input="new synthetic target\n")
new_tree = git(origin, "mktree", input=f"100644 blob {new_blob}\tfile.txt\n")
target = git(origin, "commit-tree", new_tree, "-p", base, input="target\n")
git(origin, "update-ref", "refs/heads/main", target)
(root / "target.txt").write_text(target)
(root / "base.txt").write_text(base)
object_format = git(repo, "rev-parse", "--show-object-format")
graphs = object_directory / "info/commit-graphs"
shape = {
    "refs": len(git(repo, "for-each-ref", "--format=%(refname)").splitlines()),
    "packs": len(list(packs.glob("*.pack"))), "packEntries": len(objects),
    "commitGraphLayers": len(list(graphs.glob("graph-*.graph"))), "shallowRoots": 2,
    "partialFilter": git(repo, "config", "remote.origin.partialclonefilter"),
    "packIndexBytes": sum(entry.stat().st_size for entry in packs.glob("*.idx")),
    "objectFormat": object_format, "gitVersion": git(repo, "--version"),
}
assert shape["refs"] >= 13_000 and shape["packs"] >= 1500
assert not (packs / "multi-pack-index").exists()
(root / "shape.json").write_text(json.dumps(shape, indent=2))
log(shape)
initial_packs = set(packs.iterdir())
packed_refs = repo / ".git/packed-refs"
original_refs = packed_refs.read_bytes()
original_ref_listing = git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)")
original_shallow = shallow_path.read_bytes()
original_graph = {entry.name: entry.read_bytes() for entry in graphs.iterdir()}
results = []


def timed(label, args, cwd=repo, stdin=None, extra=None):
    trace = root / f"{label}.perf"
    packet = root / f"{label}.packet"
    receipt = root / f"{label}.time"
    started = time.monotonic()
    completed = subprocess.run(
        ["/usr/bin/time", "-l", "-o", str(receipt), "git", "-C", str(cwd), *args],
        text=True, input=stdin, capture_output=True,
        env=dict(env, GIT_TRACE2_PERF=str(trace), GIT_TRACE_PACKET=str(packet),
                 **(extra or {})),
    )
    wall = time.monotonic() - started
    native = receipt.read_text()
    cpu = re.search(r"([\d.]+) user\s+([\d.]+) sys", native)
    assert cpu
    perf = trace.read_text()
    phases = {}
    for line in perf.splitlines():
        fields = [field.strip() for field in line.split("|")]
        if len(fields) > 8 and fields[3] == "region_leave":
            match = re.search(r"label:(.*)$", fields[8])
            if match:
                name = match[1]
                phases[name] = phases.get(name, 0) + float(fields[6]) * 1000
    counts = re.findall(r"write_pack_file/wrote:(\d+)", perf)
    packets = packet.read_text() if packet.exists() else ""
    result = {
        "label": label, "argv": args, "code": completed.returncode,
        "wallMs": wall * 1000, "cpuMs": sum(map(float, cpu.groups())) * 1000,
        "rss": int(re.search(r"(\d+)\s+maximum resident set size", native)[1]),
        "phases": phases, "stderr": completed.stderr, "loadAfter": os.getloadavg(),
        "receivedObjects": sum(map(int, counts)) if counts else None,
        "offeredHaves": packets.count("fetch> have "),
    }
    results.append(result)
    (root / "results.json").write_text(json.dumps(results, indent=2))
    log(result)
    return completed


fetch = [
    "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false",
    "fetch", "--no-auto-maintenance", "--no-tags", "--no-write-fetch-head",
    "--recurse-submodules=no", f"--negotiation-tip={base}", "--filter=blob:none",
    "--", origin.as_uri(), target,
]


def remove_acquired_packs():
    for entry in set(packs.iterdir()) - initial_packs:
        if entry.name != "multi-pack-index":
            entry.unlink()
    assert run(repo, ["cat-file", "-e", target], check=False).returncode != 0


def verify_source(expected_refs):
    assert packed_refs.read_bytes() == expected_refs
    if expected_refs == original_refs:
        assert git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)") == original_ref_listing
    assert shallow_path.read_bytes() == original_shallow
    assert git(repo, "rev-parse", "HEAD") == base


def sample(label, expected_refs=original_refs):
    try:
        completed = timed(label, fetch)
        assert completed.returncode == 0, completed.stderr
        assert git(repo, "cat-file", "-t", target) == "commit"
        git(repo, "merge-base", "--is-ancestor", base, target)
        verify_source(expected_refs)
    finally:
        remove_acquired_packs()


for index in range(5):
    sample(f"baseline-{index}")
completed = timed("write-midx", ["multi-pack-index", "write"])
assert completed.returncode == 0, completed.stderr
midx = (packs / "multi-pack-index").read_bytes()
(root / "saved-midx").write_bytes(midx)
try:
    for index in range(5):
        sample(f"midx-{index}")
        (packs / "multi-pack-index").unlink()
        sample(f"aa-{index}")
        (packs / "multi-pack-index").write_bytes(midx)
finally:
    (packs / "multi-pack-index").unlink(missing_ok=True)
for mode in ["--reachable", "--stdin-packs"]:
    completed = timed(
        f"graph-{mode[2:]}-shallow",
        ["commit-graph", "write", mode, "--split=no-merge"],
        stdin="\n".join(entry.name for entry in packs.glob("*.idx")) + "\n"
        if mode == "--stdin-packs" else None,
    )
    assert completed.returncode == 0, completed.stderr
log({"graphChanged": original_graph != {
    entry.name: entry.read_bytes() for entry in graphs.iterdir()
}})
for index in range(5):
    sample(f"graph-{index}")

# This measures only hypothetical pruning in the disposable fixture. Production
# refs require their owning lifecycle's liveness rules, not a blanket deletion.
pruned_refs = "# pack-refs with: peeled fully-peeled sorted\n" + "".join(
    line for line in original_refs.decode().splitlines(True)
    if line.endswith(" refs/heads/main\n") or line.endswith(" refs/remotes/origin/main\n")
)
try:
    packed_refs.write_text(pruned_refs)
    for index in range(5):
        sample(f"pruned-{index}", pruned_refs.encode())
finally:
    packed_refs.write_bytes(original_refs)


def staged_sample(label, mode):
    with tempfile.TemporaryDirectory(prefix="staging-", dir=root) as directory:
        staging = Path(directory)
        git(root, "init", "--bare", f"--object-format={object_format}", str(staging))
        (staging / "shallow").write_bytes(original_shallow)
        extra = {}
        if mode == "direct":
            extra["GIT_OBJECT_DIRECTORY"] = str(object_directory)
        else:
            (staging / "objects/info/alternates").write_text(str(object_directory) + "\n")
        args = (["-c", "core.alternateRefsCommand=true"] if mode != "default" else []) + fetch
        try:
            completed = timed(label, args, cwd=staging, extra=extra)
            assert completed.returncode == 0, completed.stderr
            assert git(staging, "cat-file", "-t", target, extra=extra) == "commit"
            git(staging, "merge-base", "--is-ancestor", base, target, extra=extra)
            assert (staging / "shallow").read_bytes() == original_shallow
            assert not git(staging, "for-each-ref", "--format=%(refname)", extra=extra)
            assert not (staging / "FETCH_HEAD").exists()
            if mode == "direct":
                assert git(repo, "cat-file", "-t", target) == "commit"
            else:
                assert run(repo, ["cat-file", "-e", target], check=False).returncode != 0
            verify_source(original_refs)
        finally:
            remove_acquired_packs()


for index in range(5):
    modes = ["default", "suppressed", "direct"]
    for mode in (modes if index % 2 == 0 else list(reversed(modes))):
        staged_sample(f"staging-{mode}-{index}", mode)
log({"complete": True, "fixture": str(repo), "restoredRefsAndShallow": True})
