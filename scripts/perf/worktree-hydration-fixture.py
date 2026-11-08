#!/usr/bin/env python3
"""Create a disposable partial clone with one missing target blob and unrelated history.

python3 scripts/perf/worktree-hydration-fixture.py /absolute/task-owned/fixture
Then copy seed per arm and run worktree-size-measure.ts --repo <copy> --allocation.
Or run the serial macOS comparison (five counterbalanced pairs):
python3 scripts/perf/worktree-hydration-fixture.py <fixture> --measure --base-file <saved-object-hydration.ts>
Repeat with --allocation for sampled heap, or --aa for two identical-source pairs.
--pairs <count> --run-name <name> selects a separate bounded replay directory.
--creation measures the managed service's default-base phases and full checkout.
For that one-argument comparison, its Git wrapper reconstructs the baseline census
command inside the real worker; the direct-owner comparison loads baseline source.
The target has 62,000 files / 1.14 GB; 600,000 historical blobs amplify the
repository-wide promisor scan without copying production data. Creation is excluded.
--extra-packs 1237 adds fragmented promisor history, for 1,239 packs before hydration.
--extra-refs 20000 adds distinct session tips in 256 packs; --advancing --shallow
requires a changed-tip refresh from a valid shallow boundary. --negotiation-tip
compares restricted hydration tips against the prior all-ref scan during --creation.
--refresh-negotiation compares restricted default-branch refresh instead; both
arms retain the current hydration command. Pass the saved baseline base-ref.ts.
Acceptance: identical commit/bytes and one batch fetch, fewer pack reads and lower
hydration CPU/wall time; no >20% owner regression. Use five AB/BA and five A/A pairs.
"""

import json
import os
from pathlib import Path
import re
import shlex
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
    creation = "--creation" in sys.argv
    negotiation = "--negotiation-tip" in sys.argv
    refresh = "--refresh-negotiation" in sys.argv
    mode = "creation" if creation else "allocation" if "--allocation" in sys.argv else "timing"
    if creation:
        candidate = Path("src/agents/worktrees/object-hydration.ts").read_text()
        if refresh:
            assert not negotiation
            assert "--negotiation-tip=${cachedCommit}" in Path("src/agents/worktrees/base-ref.ts").read_text()
            assert "--negotiation-tip=" not in baseline.read_text()
        elif negotiation:
            assert candidate.replace(
                "        // Even refetch's noop negotiator otherwise parses every local ref tip.\n"
                "        `--negotiation-tip=${commit}`,\n", "") == baseline.read_text()
        else:
            assert baseline.read_text().replace('"--no-object-names"', '"--quiet"') == candidate
    control = "--aa" in sys.argv
    run_name = sys.argv[sys.argv.index("--run-name") + 1] if "--run-name" in sys.argv else (
        f"aa-{mode}" if control else f"ab-{mode}")
    assert Path(run_name).name == run_name and run_name not in (".", "..")
    run_root = root / run_name
    run_root.mkdir()
    bin_dir = run_root / "bin"
    bin_dir.mkdir()
    actual_git = shutil.which("git")
    assert actual_git
    wrapper = bin_dir / "git"
    wrapper.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$GIT_METRICS_DIR/$$.argv"\n'
                       f'exec /usr/bin/time -l -o "$GIT_METRICS_DIR/$$.time" {shlex.quote(actual_git)} "$@"\n')
    wrapper.chmod(0o755)
    samples = int(sys.argv[sys.argv.index("--pairs") + 1]) if "--pairs" in sys.argv else 2 if control else 5
    assert samples > 0
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
            if creation:
                rewrite = ('''if [[ " $* " != *" --refetch "* ]]; then
  for ((i=0; i<${#args[@]}; i++)); do
    [[ "${args[i]}" != --negotiation-tip=* ]] || unset 'args[i]'
  done
fi
''' if refresh else '''for ((i=0; i<${#args[@]}; i++)); do
  [[ "${args[i]}" != --negotiation-tip=* ]] || unset 'args[i]'
done
''' if negotiation else '''if [[ " $* " == *" rev-list "* && " $* " == *" --missing=print "* ]]; then
  for ((i=0; i<${#args[@]}; i++)); do
    [[ "${args[i]}" != --quiet ]] || args[i]=--no-object-names
  done
fi
''') if arm == "base" or control else ""
                wrapper.write_text('#!/bin/bash\nargs=("$@")\n' + rewrite +
                                   f'metrics={shlex.quote(str(metrics))}\n' +
                                   'printf "%s\\n" "${args[*]}" > "$metrics/$$.argv"\n' +
                                   f'exec /usr/bin/time -l -o "$metrics/$$.time" {shlex.quote(actual_git)} "${{args[@]}}"\n')
            environment = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
                               GIT_METRICS_DIR=str(metrics),
                               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                               OPENCLAW_STATE_DIR=str(arm_root / "state"))
            command = ["node", "--import", "./scripts/tsx.mjs",
                       "scripts/perf/worktree-size-measure.ts", "--repo", str(clone)]
            if creation:
                command = ["node", "--import", "./scripts/tsx.mjs",
                           "scripts/perf/worktree-creation-measure.ts", "--repo", str(clone),
                           "--output", str(arm_root / "creation"), "--samples", "1", "--default-base"]
                if negotiation or refresh:
                    target = subprocess.check_output(
                        [actual_git, "-C", str(root / "origin.git"), "rev-parse", "HEAD"],
                        text=True).strip()
                    command.extend(["--expected-commit", target])
            elif arm == "base" or control:
                command.extend(["--hydration-base-file", str(baseline)])
            if mode == "allocation":
                command.append("--allocation")
            completed = subprocess.run(command, env=environment, text=True, capture_output=True)
            (arm_root / "stdout.txt").write_text(completed.stdout)
            (arm_root / "stderr.txt").write_text(completed.stderr)
            assert completed.returncode == 0, completed.stderr
            result = (json.loads((arm_root / "creation/results.json").read_text())[0] if creation
                      else json.loads(completed.stdout.splitlines()[-1]))
            if creation:
                result["phases"] = json.loads(re.search(
                    r"phaseDurationsMs=(\{[^\n]*\})", completed.stdout)[1])
            object_counts = {}
            for name, directory in (("before", root / "seed"), ("after", clone)):
                output = subprocess.check_output([actual_git, "-C", str(directory), "count-objects", "-v"], text=True)
                object_counts[name] = dict(line.split(": ") for line in output.splitlines())
            native_cpu = 0.0
            peak_rss = 0
            native_phases = {}
            for receipt in metrics.glob("*.time"):
                text = receipt.read_text()
                cpu = re.search(r"([\d.]+) user\s+([\d.]+) sys", text)
                assert cpu, text
                native_cpu += float(cpu[1]) + float(cpu[2])
                peak_rss = max(peak_rss, int(re.search(r"(\d+)\s+maximum resident set size", text)[1]))
                argv = receipt.with_suffix(".argv").read_text()
                phase = ("hydrationFetch" if "--refetch" in argv else "refreshFetch"
                         if "fetch " in argv else "sizeScan" if "ls-tree " in argv
                         else "census" if "--missing=print" in argv else "fastForward"
                         if "merge --ff-only" in argv else "other")
                measured = native_phases.setdefault(phase, dict(count=0, wallMs=0, cpuMs=0, peakRssBytes=0))
                measured["count"] += 1
                measured["wallMs"] += float(re.search(r"([\d.]+) real", text)[1]) * 1000
                measured["cpuMs"] += (float(cpu[1]) + float(cpu[2])) * 1000
                measured["peakRssBytes"] = max(measured["peakRssBytes"], int(re.search(r"(\d+)\s+maximum resident set size", text)[1]))
            commands = [entry.read_text() for entry in metrics.glob("*.argv")]
            result.update(label=label, arm=arm, control=control, nativePhases=native_phases, gitCpuMs=native_cpu * 1000,
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
clone_packs = list((seed / ".git/objects/pack").glob("*.pack"))
for pack in bulk_packs:
    for suffix in (".pack", ".idx"):
        shutil.copyfile(pack.with_suffix(suffix), seed / ".git/objects/pack" / pack.with_suffix(suffix).name)
    (seed / ".git/objects/pack" / pack.with_suffix(".promisor").name).touch()
extra_packs = int(sys.argv[sys.argv.index("--extra-packs") + 1]) if "--extra-packs" in sys.argv else 0
assert 0 <= extra_packs <= 600_000
if extra_packs:
    history = git(origin, "ls-tree", "-r", "--format=%(objectname)", "history").splitlines()
    for index in range(extra_packs):
        # Duplicate historical objects model fragmented fetches without repacking the seed.
        objects = history[index::extra_packs]
        packed = subprocess.check_output(
            ["git", "-C", str(origin), "pack-objects", "--window=0", "--threads=1",
             str(seed / ".git/objects/pack/pack")],
            input=("\n".join(objects) + "\n").encode(), env=env).decode().strip()
        (seed / ".git/objects/pack" / f"pack-{packed}.promisor").touch()
git(seed, "config", "gc.auto", "0")
git(seed, "config", "maintenance.auto", "false")
extra_refs = int(sys.argv[sys.argv.index("--extra-refs") + 1]) if "--extra-refs" in sys.argv else 0
assert 0 <= extra_refs <= 100_000
if extra_refs:
    base = git(seed, "rev-parse", "HEAD~1")
    packs_before = set((seed / ".git/objects/pack").glob("*.pack"))
    commits = []
    for index in range(extra_refs):
        message = f"synthetic session {index}"
        commits.append(f"commit refs/heads/synthetic-{index}\ncommitter Fixture <fixture@example.invalid> {1700000001 + index} +0000\ndata {len(message)}\n{message}\nfrom {base}\n\n")
    subprocess.run(["git", "-C", str(seed), "fast-import", "--quiet"],
                   input="".join(commits).encode(), env=env, check=True)
    imported = set((seed / ".git/objects/pack").glob("*.pack")) - packs_before
    tips = git(seed, "for-each-ref", "--format=%(objectname)", "refs/heads/synthetic-*").splitlines()
    for index in range(min(256, extra_refs)):
        packed = subprocess.check_output(
            ["git", "-C", str(seed), "pack-objects", "--window=0", "--threads=1",
             str(seed / ".git/objects/pack/pack")],
            input=("\n".join(tips[index::256]) + "\n").encode(), env=env).decode().strip()
        (seed / ".git/objects/pack" / f"pack-{packed}.promisor").touch()
    for pack in imported:
        for suffix in (".pack", ".idx", ".rev"):
            pack.with_suffix(suffix).unlink(missing_ok=True)
    git(seed, "pack-refs", "--all")
missing = git(seed, "rev-list", "--objects", "--missing=print", "--no-object-names", "--max-count=1", "HEAD")
assert sum(line.startswith("?") for line in missing.splitlines()) == 1
if "--shallow" in sys.argv:
    (seed / ".git/shallow").write_text(git(seed, "rev-parse", "HEAD~1") + "\n")
if "--advancing" in sys.argv:
    base = git(seed, "rev-parse", "HEAD~1")
    git(seed, "update-ref", "refs/heads/main", base)
    git(seed, "update-ref", "refs/remotes/origin/main", base)
    # Bulk packs contain the old tree/history. Remove the clone's new-tip objects
    # so refresh must actually acquire the advancing commit, not just update a ref.
    for pack in clone_packs:
        for suffix in (".pack", ".idx", ".rev", ".promisor"):
            pack.with_suffix(suffix).unlink(missing_ok=True)
    git(seed, "read-tree", "--reset", "-u", "HEAD")
print(json.dumps({"root": str(root), "files": 62000, "targetBytes": 62000 * 18432,
                  "unrelatedHistoricalBlobs": 600000, "missingTargetObjects": 1,
                  "extraRefs": extra_refs, "packs": len(list((seed / ".git/objects/pack").glob("*.pack"))),
                  "commit": git(seed, "rev-parse", "HEAD")}))
