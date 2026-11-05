#!/usr/bin/env python3
"""Create a disposable partial clone with one missing target blob and unrelated history.

python3 scripts/perf/worktree-hydration-fixture.py /absolute/task-owned/fixture
Then copy seed per arm and run worktree-size-measure.ts --repo <copy> --allocation.
Or run the serial macOS comparison (five counterbalanced pairs):
python3 scripts/perf/worktree-hydration-fixture.py <fixture> --measure --base-file <saved-object-hydration.ts>
Repeat with --allocation for sampled heap, or --aa for two identical-source pairs.
The target has 62,000 files / 1.14 GB; 600,000 historical blobs amplify the
repository-wide promisor scan without copying production data. Creation is excluded.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
if "--measure" in sys.argv:
    # macOS native timing: every Git launch has its own wait4 CPU receipt,
    # including native grandchildren. JS owner CPU/allocation is reported separately.
    assert sys.platform == "darwin", "native CPU wrapper currently uses macOS time -l"
    baseline = Path(sys.argv[sys.argv.index("--base-file") + 1]).resolve()
    assert baseline.is_file()
    mode = "allocation" if "--allocation" in sys.argv else "timing"
    control = "--aa" in sys.argv
    run_root = root / (f"aa-{mode}" if control else f"ab-{mode}")
    run_root.mkdir()
    bin_dir = run_root / "bin"
    bin_dir.mkdir()
    actual_git = shutil.which("git")
    assert actual_git
    wrapper = bin_dir / "git"
    wrapper.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$GIT_METRICS_DIR/$$.argv"\n'
                       f'exec /usr/bin/time -l -o "$GIT_METRICS_DIR/$$.time" "{actual_git}" "$@"\n')
    wrapper.chmod(0o755)
    samples = 2 if control else 5
    results = []
    for pair in range(samples):
        # ABAB followed by BABA avoids always favoring the second filesystem read.
        for arm in (["base", "candidate"] if pair % 2 == 0 else ["candidate", "base"]):
            label = f"{pair}-{arm}"
            arm_root = run_root / label
            arm_root.mkdir()
            clone = arm_root / "clone"
            shutil.copytree(root / "seed", clone)
            metrics = arm_root / "git-metrics"
            metrics.mkdir()
            environment = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
                               GIT_METRICS_DIR=str(metrics),
                               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                               OPENCLAW_STATE_DIR=str(arm_root / "state"))
            command = ["node", "--import", "./scripts/tsx.mjs",
                       "scripts/perf/worktree-size-measure.ts", "--repo", str(clone)]
            if arm == "base" or control:
                command.extend(["--hydration-base-file", str(baseline)])
            if mode == "allocation":
                command.append("--allocation")
            completed = subprocess.run(command, env=environment, text=True, capture_output=True)
            (arm_root / "stdout.txt").write_text(completed.stdout)
            (arm_root / "stderr.txt").write_text(completed.stderr)
            assert completed.returncode == 0, completed.stderr
            result = json.loads(completed.stdout.splitlines()[-1])
            object_counts = {}
            for name, directory in (("before", root / "seed"), ("after", clone)):
                output = subprocess.check_output([actual_git, "-C", str(directory), "count-objects", "-v"], text=True)
                object_counts[name] = dict(line.split(": ") for line in output.splitlines())
            native_cpu = 0.0
            peak_rss = 0
            for receipt in metrics.glob("*.time"):
                text = receipt.read_text()
                cpu = re.search(r"([\d.]+) user\s+([\d.]+) sys", text)
                assert cpu, text
                native_cpu += float(cpu[1]) + float(cpu[2])
                peak_rss = max(peak_rss, int(re.search(r"(\d+)\s+maximum resident set size", text)[1]))
            commands = [entry.read_text() for entry in metrics.glob("*.argv")]
            result.update(label=label, arm=arm, control=control, gitCpuMs=native_cpu * 1000,
                          gitPeakRssBytes=peak_rss, gitCommands=len(commands),
                          acquiredObjects=sum(int(object_counts["after"][key]) - int(object_counts["before"][key])
                                              for key in ("count", "in-pack")),
                          promisorScans=sum("--missing=allow-promisor" in cmd for cmd in commands),
                          fetches=sum("fetch --refetch" in cmd for cmd in commands))
            results.append(result)
            print(json.dumps(result), flush=True)
            shutil.rmtree(clone)
    (run_root / "results.json").write_text(json.dumps(results, indent=2))
    sys.exit(0)

root.mkdir()
origin = root / "origin.git"
seed = root / "seed"
env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")


def git(cwd, *args):
    return subprocess.check_output(["git", "-C", str(cwd), *args], env=env).decode().strip()


git(root, "init", "--bare", "--initial-branch=main", str(origin))
git(origin, "config", "uploadpack.allowFilter", "true")
git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
git(origin, "config", "gc.auto", "0")
git(origin, "config", "maintenance.auto", "false")


def import_objects(final=False):
    process = subprocess.Popen(["git", "-C", str(origin), "fast-import", "--quiet"],
                               stdin=subprocess.PIPE, env=env)
    stream = process.stdin
    assert stream is not None

    def blob(mark, payload):
        stream.write(f"blob\nmark :{mark}\ndata {len(payload)}\n".encode())
        stream.write(payload + b"\n")

    def commit(ref, message, parent=None):
        stream.write(f"commit refs/heads/{ref}\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata {len(message)}\n{message}\n".encode())
        if parent:
            stream.write(f"from {parent}\n".encode())

    if final:
        blob(1, b"missing target blob\n".ljust(18_432, b"m"))
        commit("main", "missing target", git(origin, "rev-parse", "main"))
        stream.write(b"M 100644 :1 target/missing.txt\n\n")
    else:
        for index in range(61_999):
            blob(index + 1, f"synthetic target {index}\n".encode().ljust(18_432, b"x"))
        commit("main", "target base")
        for index in range(61_999):
            stream.write(f"M 100644 :{index + 1} target/d{index // 100}/f{index}.txt\n".encode())
        stream.write(b"\n")
        for index in range(600_000):
            blob(62_000 + index, f"unrelated historical blob {index}\n".encode().ljust(128, b"h"))
        commit("history", "unrelated history")
        for index in range(600_000):
            stream.write(f"M 100644 :{62_000 + index} history/d{index // 100}/f{index}.txt\n".encode())
        stream.write(b"\n")
    stream.close()
    assert process.wait() == 0


import_objects()
bulk_packs = list((origin / "objects/pack").glob("*.pack"))
import_objects(final=True)
git(root, "clone", "--filter=blob:none", "--no-checkout", origin.as_uri(), str(seed))
for pack in bulk_packs:
    for suffix in (".pack", ".idx"):
        shutil.copyfile(pack.with_suffix(suffix), seed / ".git/objects/pack" / pack.with_suffix(suffix).name)
    (seed / ".git/objects/pack" / pack.with_suffix(".promisor").name).touch()
git(seed, "config", "gc.auto", "0")
git(seed, "config", "maintenance.auto", "false")
missing = git(seed, "rev-list", "--objects", "--missing=print", "--no-object-names", "--max-count=1", "HEAD")
assert sum(line.startswith("?") for line in missing.splitlines()) == 1
print(json.dumps({"root": str(root), "files": 62000, "targetBytes": 62000 * 18432,
                  "unrelatedHistoricalBlobs": 600000, "missingTargetObjects": 1,
                  "commit": git(seed, "rev-parse", "HEAD")}))
