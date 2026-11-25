"""Measure marginal retained-generation disk on disposable Btrfs, never production state.

Run in a privileged, network-disabled Linux container with btrfs-progs and Git.
Mount a synthetic worktree-creation-measure.ts fixture read-only at --fixture and
an empty scratch directory at --root. The loop image needs 45 GiB physical space.
This is native storage accounting, not full template-owner latency or Gateway load.
"""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--fixture", type=Path, required=True)
parser.add_argument("--root", type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
assert root.is_dir() and not any(root.iterdir()), "Use an empty disposable root"
env = {"PATH": os.environ["PATH"], "HOME": str(root), "LC_ALL": "C",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}


def run(*argv):
    return subprocess.check_output(argv, env=env, text=True).strip()


def git(directory, *argv):
    return run("git", "-C", str(directory), *argv)


mount = root / "btrfs"
mount.mkdir()
image = root / "disk.img"
run("truncate", "-s", "64G", str(image))
loop = run("losetup", "--find", "--show", str(image))
mounted = False
try:
    run("mkfs.btrfs", "-f", loop)
    run("mount", "-t", "btrfs", loop, str(mount))
    mounted = True
    database = mount / "synthetic-sessions.sqlite"
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, payload BLOB)")
        for index in range(5000):
            db.execute("INSERT INTO sessions VALUES (?, zeroblob(?))", (index, 35 * 1024**3 // 5000))
    repo = mount / "repo"
    run("git", "clone", "--bare", "--no-hardlinks", str(args.fixture), str(repo))
    base = git(repo, "rev-parse", "HEAD^")
    head = git(repo, "rev-parse", "HEAD")
    first, second = mount / "a", mount / "b"
    run("btrfs", "subvolume", "create", str(first))
    git(repo, "worktree", "add", "--detach", "--no-checkout", str(first), base)
    git(first, "read-tree", "--reset", "-u", base)
    # Match the managed refresh's independent Git registration and cloned index.
    git(repo, "worktree", "add", "--detach", "--no-checkout", str(second), base)
    marker = (second / ".git").read_bytes()
    (second / ".git").unlink()
    second.rmdir()
    run("btrfs", "subvolume", "snapshot", str(first), str(second))
    (second / ".git").unlink()
    (second / ".git").write_bytes(marker)
    index_a = git(first, "rev-parse", "--git-path", "index")
    index_b = git(second, "rev-parse", "--git-path", "index")
    run("cp", "--reflink=always", index_a, index_b)
    git(second, "update-index", "--refresh")
    git(second, "read-tree", "-m", "-u", base, head)
    git(second, "update-ref", "HEAD", head)
    assert git(first, "status", "--porcelain") == git(second, "status", "--porcelain") == ""
    run("btrfs", "filesystem", "sync", str(mount))
    report = {
        "scope": "Native managed source clone and Git refresh; no registry or Gateway",
        "databaseBytes": database.stat().st_size,
        "sessions": 5000,
        "trackedFiles": len(git(first, "ls-files").splitlines()),
        "changedFiles": len(git(repo, "diff", "--name-only", base, head).splitlines()),
        "extents": run("btrfs", "filesystem", "du", "--raw", "-s", str(first), str(second)),
        "bothGenerations": run("btrfs", "filesystem", "usage", "-b", str(mount)),
    }
    run("btrfs", "subvolume", "delete", str(first))
    git(repo, "worktree", "prune")
    run("btrfs", "subvolume", "sync", str(mount))
    run("btrfs", "filesystem", "sync", str(mount))
    report["oneGeneration"] = run("btrfs", "filesystem", "usage", "-b", str(mount))
    (root / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
finally:
    if mounted:
        run("umount", str(mount))
    run("losetup", "-d", loop)
    image.unlink()
    shutil.rmtree(mount)
