"""Synthetic fixture for git-operation-allocation-measure.ts; pass an empty output directory."""

import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
repo = root / "repo"
repo.mkdir(parents=True, exist_ok=False)


def git(*args, input=None):
    result = subprocess.run(
        ["git", "-C", str(repo), "-c", f"core.hooksPath={os.devnull}", "-c", "core.fsmonitor=false", *args],
        input=input,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"},
    )
    return result.stdout.decode().strip()


git("init", "-b", "main")
git("config", "gc.auto", "0")
git("config", "maintenance.auto", "false")
git("config", "user.name", "Synthetic Fixture")
git("config", "user.email", "fixture@example.invalid")
commands = []
for index in range(5000):
    body = (f"synthetic history {index}\n" + "line of text\n" * 32).encode()
    message = f"commit {index}\n".encode()
    commands.append(
        (
            "commit refs/heads/main\n"
            f"committer Synthetic Fixture <fixture@example.invalid> {1700000000 + index} +0000\n"
            f"data {len(message)}\n"
        ).encode()
        + message
        + f"M 100644 inline tracked/file-{index % 512:04d}.txt\ndata {len(body)}\n".encode()
        + body
        + b"\n"
    )
git("fast-import", "--quiet", input=b"".join(commands))
git("reset", "--hard", "HEAD")
head = git("rev-parse", "HEAD")
base = git("rev-parse", "HEAD~10")
git("remote", "add", "origin", "https://github.com/synthetic/perf-fixture.git")
refs = "".join(f"update refs/heads/fixture-{index:04d} {head}\n" for index in range(4096))
refs += (
    f"update refs/remotes/origin/main {base}\n"
    f"update refs/remotes/origin/feature {head}\n"
    f"update refs/heads/feature {head}\n"
)
git("update-ref", "--stdin", input=refs.encode())
git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
git("checkout", "feature")
git("pack-refs", "--all", "--prune")

# Independent valid packs with unique object sets; no production state or bulk payloads.
objects = git("rev-list", "--objects", "--all").splitlines()
pack_directory = repo / ".git/objects/pack"
original = list(pack_directory.iterdir())
for index in range(128):
    ids = [line.split(" ")[0] for line in objects[index::128]]
    git("pack-objects", str(pack_directory / "pack"), input=("\n".join(ids) + "\n").encode())
for file in original:
    file.unlink()
for index in range(64):
    git("worktree", "add", "--detach", str(root / f"worktrees/wt-{index:03d}"), "HEAD")
for index in range(10000):
    file = repo / f"untracked/d{index // 100:03d}/file-{index:05d}.txt"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("new line\n" * 8)
for index in range(20):
    file = repo / f"tracked/file-{index:04d}.txt"
    file.write_text(file.read_text() + "modified\n")
metadata = {
    "root": str(repo), "commits": 5000, "tracked": 512, "packs": 128,
    "worktrees": 64, "untracked": 10000, "packedRefs": 4100,
    "packedRefsBytes": (repo / ".git/packed-refs").stat().st_size,
    "head": head, "base": base,
}
(root / "fixture.json").write_text(json.dumps(metadata, indent=2))
print(json.dumps(metadata))
