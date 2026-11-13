#!/usr/bin/env python3
"""Prepare an empty-source/fork retry fixture, without production data or network.

python3 scripts/perf/empty-source-fork-fixture.py <new-root> [--history <bare-repo>]
Reuse a synthetic history read-only when supplied; otherwise build 20,001 commits
and 62,000 stable paths (1.116 GB logical content, deduplicated and unmaterialized).
Run publication-fetch-measure.ts --sequential-fork for five interleaved A/B/A2
trials. Acceptance: the second acquisition advertises the first fetched commit,
downloads only the new commit, preserves HEAD, and reduces transfer/CPU/wall.
Initial full transfer is outside successor timing and remains in first.git.perf.
This owner never reads the agent database; no synthetic 35 GiB DB is necessary.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=Path)
parser.add_argument("--history", type=Path)
args = parser.parse_args()
root = args.root.resolve()
root.mkdir()
env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
           GIT_ALLOW_PROTOCOL="file", GIT_NO_LAZY_FETCH="1",
           GIT_CONFIG_PARAMETERS="'gc.auto=0' 'maintenance.auto=false'")


def git(cwd, *argv, input=None):
    return subprocess.check_output(["git", "-C", str(cwd), *argv], env=env,
                                   input=input).decode().strip()


remote = root / "origin.git"
if args.history:
    git(root, "clone", "--bare", "--shared", str(args.history.resolve()), str(remote))
else:
    git(root, "init", "--bare", "--initial-branch=main", str(remote))
    process = subprocess.Popen(["git", "-C", str(remote), "fast-import", "--quiet"],
                               stdin=subprocess.PIPE, env=env)
    stream = process.stdin
    assert stream is not None
    content = "synthetic workspace\n".ljust(18_000, "x")
    stream.write((f"blob\nmark :1\ndata {len(content)}\n{content}\n"
                  "commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> "
                  "1700000000 +0000\ndata 4\nbase\n").encode())
    for index in range(62_000):
        stream.write(f"M 100644 :1 files/{index // 1000}/file-{index}.txt\n".encode())
    stream.write(b"\n")
    for index in range(20_000):
        payload = f"synthetic revision {index}\n"
        stream.write(("commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> "
                      f"{1700000001 + index} +0000\ndata 7\nhistory\n"
                      "M 100644 inline history/d0/d1/d2/d3/d4/file.txt\n"
                      f"data {len(payload)}\n{payload}\n").encode())
    stream.close()
    assert process.wait() == 0
for key, value in [("uploadpack.allowFilter", "true"),
                   ("uploadpack.allowAnySHA1InWant", "true")]:
    git(remote, "config", key, value)
upstream = git(remote, "rev-parse", "HEAD")
tree = git(remote, "rev-parse", "HEAD^{tree}")


def commit(repo, tree_oid, parent, message):
    text = f"tree {tree_oid}\n" + (f"parent {parent}\n" if parent else "")
    text += ("author Fixture <fixture@example.invalid> 0 +0000\n"
             f"committer Fixture <fixture@example.invalid> 0 +0000\n\n{message}\n")
    return git(repo, "hash-object", "-t", "commit", "-w", "--stdin", input=text.encode())


first = commit(remote, tree, upstream, "fork first")
second = commit(remote, tree, first, "fork successor")
git(remote, "update-ref", "refs/heads/fork", second)
seed = root / "seed"
git(root, "init", "--initial-branch=main", str(seed))
empty_tree = git(seed, "mktree", input=b"")
synthetic = commit(seed, empty_tree, None, "empty workspace")
git(seed, "update-ref", "refs/heads/main", synthetic)
for key, value in [("gc.auto", "0"), ("maintenance.auto", "false"),
                   ("fetch.unpackLimit", "1")]:
    git(seed, "config", key, value)
shape = {"upstream": upstream, "first": first, "second": second,
         "synthetic": synthetic, "stablePaths": 62_000,
         "logicalStableBytes": 62_000 * 18_000,
         "historyReused": str(args.history.resolve()) if args.history else None,
         "historyCommits": int(git(remote, "rev-list", "--count", upstream)),
         "gitVersion": git(remote, "--version")}
(root / "shape.json").write_text(json.dumps(shape, indent=2) + "\n")
print(json.dumps(shape))
