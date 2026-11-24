"""Synthetic revision-export benchmark; run with Python 3 and Git on POSIX.

Usage: python3 scripts/perf/pr-export-tree.py NEW_DIRECTORY [--samples 5]
Creates 62,000 files / ~1.1 GB in hundreds of packs, then interleaves archive and
bounded exports. All data is synthetic. Fresh partial clones isolate hydration;
warm runs reuse the populated source. Metrics include child CPU, RSS, and on
Linux physical input bytes from wait4, plus Trace2 and packed-object access logs.
"""

import argparse
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
parser.add_argument("--samples", type=int, default=5)
parser.add_argument("--states", nargs="+", choices=["warm", "partial", "cold"], default=["warm", "partial"])
args = parser.parse_args()
root = args.directory.resolve()
root.mkdir(parents=True, exist_ok=False)
repo = root / "source"
repo.mkdir()
exporter = Path(__file__).resolve().parents[1] / "pr-lib/export-tree.py"
env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")


def git(*argv, cwd=repo, **options):
    return subprocess.check_output(["git", "-C", str(cwd), *argv], env=env, **options)


git("init", "-q", "-b", "main")
git("config", "gc.auto", "0")
git("config", "maintenance.auto", "false")
git("config", "uploadpack.allowFilter", "true")
with subprocess.Popen(["git", "-C", str(repo), "fast-import", "--quiet"], stdin=subprocess.PIPE, env=env) as child:
    child.stdin.write(b"commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 8\nfixture\n")
    for index in range(62000):
        name = f"workspaces/w{index // 100:04}/f{index:05}.bin"
        if index < 2:
            name = ["scripts/pr", "scripts/pr-lib/fixture.mjs"][index]
        data = os.urandom(18000) if index > 1 else f"fixture {index}\n".encode()
        mode = "100755" if index == 0 else "100644"
        child.stdin.write(f"M {mode} inline {name}\ndata {len(data)}\n".encode() + data + b"\n")
    child.stdin.write(b"\ndone\n")
    child.stdin.close()
    if child.wait() != 0:
        raise RuntimeError("fixture import failed")
git("repack", "-ad", "--window=0", "--depth=0", "--max-pack-size=3m")
packs = sorted((repo / ".git/objects/pack").glob("*.pack"))
for pack in packs[:341]:
    pack.with_suffix(".promisor").touch()
git("config", "remote.origin.promisor", "true")
git("config", "remote.origin.url", "file:///nonexistent-synthetic-remote")
git("config", "remote.origin.partialclonefilter", "blob:none")
results = []
metadata = {"git": git("--version").decode().strip(), "files": 62000,
            "packs": len(packs), "packBytes": sum(p.stat().st_size for p in packs),
            "platform": sys.platform, "load": os.getloadavg()}
print(json.dumps(metadata), flush=True)


def measure(kind, state, index):
    label = f"{state}-{kind}-{index}"
    with tempfile.TemporaryDirectory(prefix=label, dir=root) as temporary:
        work = Path(temporary)
        source = repo
        if state == "partial":
            source = work / "clone"
            git("clone", "--quiet", "--no-checkout", "--filter=blob:none", repo.as_uri(), str(source))
        before_packs = sum(p.stat().st_size for p in (source / ".git/objects/pack").glob("*.pack"))
        output = work / "export"
        output.mkdir()
        trace = root / f"{label}.perf"
        access = root / f"{label}.packs"
        run_env = dict(env, GIT_TRACE2_PERF=str(trace), GIT_TRACE_PACK_ACCESS=str(access))
        if state == "cold":
            # Evict only this synthetic store's clean pack/index pages, never
            # the host's global cache or another repository's data.
            for file in (source / ".git/objects/pack").iterdir():
                with file.open("rb") as stream:
                    os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
        if kind == "archive":
            command = ["sh", "-c", 'git -C "$1" archive --output="$2/tree.tar" main -- scripts/pr scripts/pr-lib && tar -xf "$2/tree.tar" -C "$3"',
                       "export", str(source), str(work), str(output)]
        else:
            command = [sys.executable, "-I", "-B", str(exporter), shutil.which("git"), str(source), "main", str(output), "scripts/pr", "scripts/pr-lib"]
        start = time.perf_counter()
        child = subprocess.Popen(command, env=run_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        # wait4 records this process tree's peak rather than the harness lifetime peak.
        _, wait_status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(wait_status)
        error = child.stderr.read()
        if child.returncode:
            raise RuntimeError(error.decode())
        elapsed = time.perf_counter() - start
        after_packs = sum(p.stat().st_size for p in (source / ".git/objects/pack").glob("*.pack"))
        for file_index, name in enumerate(["scripts/pr", "scripts/pr-lib/fixture.mjs"]):
            assert (output / name).read_bytes() == f"fixture {file_index}\n".encode()
        row = {"kind": kind, "state": state, "sample": index, "seconds": elapsed,
               "cpuSeconds": usage.ru_utime + usage.ru_stime,
               "rssBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024),
               "inputBytes": usage.ru_inblock * 512, "minorFaults": usage.ru_minflt,
               "fetchedPackBytes": after_packs - before_packs,
               "packAccesses": len(access.read_text().splitlines())}
        results.append(row)
        print(json.dumps(row), flush=True)
        (root / "results.json").write_text(json.dumps({"fixture": metadata, "samples": results}, indent=2))


# A/A controls followed by paired A/B samples; each partial run starts unhydrated.
for state in args.states:
    for index in range(2):
        measure("archive", state, f"control-{index}")
    for index in range(args.samples):
        for kind in ["archive", "export"]:
            measure(kind, state, index)
