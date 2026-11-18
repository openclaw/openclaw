#!/usr/bin/env python3
"""Measure the real hydration owner with a fragmented synthetic partial clone.

--prepare ROOT builds on worktree-hydration-fixture.py: ~62k paths/1.14GB,
600k historical blobs, 1500 packs, then 13k refs and small/large missing batches.
--measure ROOT --output OUT --base-file saved-object-hydration.ts runs five
counterbalanced baseline/candidate pairs plus five A/A pairs, serially. Each
sample replays the same OID inventory twice; --concurrent submits both at once.
Acceptance: identical wants/bytes, less native CPU/wall, no >20% owner regression.
Setup, copying and imports are excluded. No production repositories or network
remotes: only the generated file:// origin is allowed. Native CPU includes the
local server; JS allocation is the Node 26 exact V8 counter, not native malloc.
"""

import argparse
import json
import os
from pathlib import Path
import random
import re
import shlex
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("--prepare", type=Path)
mode.add_argument("--measure", type=Path)
parser.add_argument("--output", type=Path)
parser.add_argument("--base-file", type=Path)
parser.add_argument("--pairs", type=int, default=5)
parser.add_argument("--shapes", nargs="+", default=["small", "large"])
parser.add_argument("--concurrent", action="store_true")
args = parser.parse_args()
git = shutil.which("git")
assert git
env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
           GIT_NO_LAZY_FETCH="1")
root = (args.prepare or args.measure).resolve()
seed = root / "seed"
origin = root / "origin.git"


def command(cwd, *argv, data=None):
    return subprocess.check_output([git, "-C", str(cwd), *argv], input=data, env=env).decode().strip()


if args.prepare:
    subprocess.run(["python3", "scripts/perf/worktree-hydration-fixture.py", str(root),
                    "--extra-packs", "1498"], env=env, check=True)
    base = command(seed, "rev-parse", "HEAD")
    commits = "".join(
        f"commit refs/heads/session-{i}\ncommitter Fixture <fixture@example.invalid> "
        f"{1700000000+i} +0000\ndata 7\nsession\nfrom {base}\n\n" for i in range(13000))
    command(seed, "fast-import", "--quiet", data=commits.encode())
    command(seed, "pack-refs", "--all")
    for name, count, size in [("small", 84, 320000), ("large", 58522, 18432)]:
        process = subprocess.Popen([git, "-C", str(origin), "fast-import", "--quiet"],
                                   stdin=subprocess.PIPE, env=env)
        stream = process.stdin
        assert stream is not None
        for i in range(count):
            payload = (random.Random(i).randbytes(size) if name == "small" else
                       f"large target {i}\n".encode().ljust(size, b"L"))
            stream.write(f"blob\nmark :{i+1}\ndata {len(payload)}\n".encode() + payload + b"\n")
        stream.write(f"commit refs/heads/{name}\ncommitter Fixture <fixture@example.invalid> "
                     f"1700005000 +0000\ndata {len(name)}\n{name}\nfrom {base}\n".encode())
        for i in range(count):
            stream.write(f"M 100644 :{i+1} target/d{i//100}/f{i}.txt\n".encode())
        stream.write(b"\n")
        stream.close()
        assert process.wait() == 0
        command(seed, "fetch", "--filter=blob:none", "--no-auto-maintenance", "origin",
                f"{name}:refs/heads/{name}")
        # Construction owns the absent set; avoid a costly setup-only missing-object census.
        tree = command(origin, "ls-tree", "-r", "--format=%(objectname) %(path)", name)
        missing = []
        for line in tree.splitlines():
            oid, file = line.split(" ", 1)
            if file == "target/missing.txt" or int(file.rsplit("/f", 1)[1].split(".")[0]) < count:
                missing.append(oid)
        assert len(missing) == count + 1
        (root / f"{name}.oids").write_text("\n".join(missing) + "\n")
    print(json.dumps({"seed": str(seed), "packs": len(list((seed / ".git/objects/pack").glob("*.pack"))),
                      "smallObjects": 85, "largeObjects": 58523, "paths": 62000}))
else:
    assert args.output and args.base_file and args.pairs > 0
    assert os.uname().sysname == "Darwin", "Native CPU receipts require macOS time -l"
    assert command(seed, "remote", "get-url", "origin") == origin.as_uri()
    output = args.output.resolve()
    output.mkdir()
    baseline = args.base_file.resolve()
    assert baseline.is_file()
    results = []
    for shape in args.shapes:
        tip = command(seed, "rev-parse", shape)
        objects = root / f"{shape}.oids"
        assert objects.is_file()
        for control in [False, True]:
            for pair in range(args.pairs):
                for arm in (["base", "candidate"] if pair % 2 == 0 else ["candidate", "base"]):
                    sample = output / f"{shape}-{'aa' if control else 'ab'}-{pair}-{arm}"
                    sample.mkdir()
                    clone = sample / "clone"

                    def copy(source, destination):
                        return (os.link(source, destination) if "/objects/" in str(source)
                                else shutil.copy2(source, destination))

                    shutil.copytree(seed, clone, copy_function=copy)
                    metrics = sample / "metrics"
                    metrics.mkdir()
                    bin_dir = sample / "bin"
                    bin_dir.mkdir()
                    wrapper = bin_dir / "git"
                    wrapper.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$GIT_METRICS_DIR/$$.argv"\n'
                                       f'exec /usr/bin/time -l -o "$GIT_METRICS_DIR/$$.time" {shlex.quote(git)} "$@"\n')
                    wrapper.chmod(0o755)
                    run_env = dict(env, PATH=f"{bin_dir}:{env['PATH']}", GIT_METRICS_DIR=str(metrics),
                                   GIT_TRACE2_EVENT=str(sample / "trace.jsonl"),
                                   OPENCLAW_STATE_DIR=str(sample / "state"))
                    argv = ["node", "--import", "./scripts/tsx.mjs", "scripts/perf/worktree-size-measure.ts",
                            "--repo", str(clone), "--ref", tip, "--hydrate-objects", str(objects),
                            "--iterations", "1" if args.concurrent else "2"]
                    if args.concurrent:
                        argv.append("--concurrent")
                    if control or arm == "base":
                        argv += ["--hydration-base-file", str(baseline)]
                    completed = subprocess.run(argv, env=run_env, capture_output=True, text=True)
                    (sample / "stdout.txt").write_text(completed.stdout)
                    (sample / "stderr.txt").write_text(completed.stderr)
                    assert completed.returncode == 0, completed.stderr
                    result = json.loads(completed.stdout.splitlines()[-1])
                    receipts = []
                    for receipt in metrics.glob("*.time"):
                        content = receipt.read_text()
                        cpu = re.search(r"([\d.]+) user\s+([\d.]+) sys", content)
                        receipts.append({"argv": receipt.with_suffix(".argv").read_text().strip(),
                                         "wallMs": float(re.search(r"([\d.]+) real", content)[1]) * 1000,
                                         "cpuMs": (float(cpu[1]) + float(cpu[2])) * 1000,
                                         "rss": int(re.search(r"(\d+)\s+maximum resident set size", content)[1])})
                    events = [json.loads(line) for line in (sample / "trace.jsonl").read_text().splitlines()]
                    result.update(shape=shape, arm=arm, control=control, pair=pair, native=receipts,
                                  gitCpuMs=sum(row["cpuMs"] for row in receipts),
                                  gitPeakRssBytes=max(row["rss"] for row in receipts),
                                  transferredObjects=sum(int(e["value"]) for e in events if e.get("key") == "written"),
                                  transferredBytes=sum(int(e["value"]) for e in events if e.get("key") == "write_pack_file/wrote_bytes"))
                    results.append(result)
                    (output / "results.json").write_text(json.dumps(results, indent=2))
                    print(json.dumps(result), flush=True)
                    shutil.rmtree(clone)
