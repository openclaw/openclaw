#!/usr/bin/env python3
"""Measure native Git's repeated content verification after index stat churn.

This standard-library probe reproduces Git operations used by
readCheckoutDiffRevision and collectTrackedFiles. It does not run a Gateway or
measure JavaScript allocation.

Each arm starts from the same saved index after timestamp-only file changes.
base-A and base-A2 are identical-code controls; managed lets status retain its
verified stat data. Seeding is untimed. The first round is reported separately,
not called OS-cache-cold: this script never drops filesystem caches.
Accept lower status-plus-raw latency/CPU with stable A/A controls and no slower
next-status reads; compare response hashes before interpreting timing differences.

Requires Python 3.9+ and Git on Linux/macOS. Use a new synthetic directory on the
filesystem under study; never point this at an existing checkout or real data.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import resource
import subprocess
import time


def positive_int(value):
    result = int(value)
    if result < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="new synthetic checkout directory")
    parser.add_argument("--output", type=Path, required=True, help="new JSON file outside the checkout")
    parser.add_argument("--trace", type=Path, help="new Git Trace2 performance file outside the checkout")
    parser.add_argument("--files", type=positive_int, default=62_000)
    parser.add_argument("--bytes", type=positive_int, default=17_742, dest="file_bytes")
    parser.add_argument("--samples", type=positive_int, default=5, help="warm rounds after the initial round")
    args = parser.parse_args()
    root = args.root.absolute()
    output = args.output.absolute()
    trace = args.trace.absolute() if args.trace else None
    for destination in (output, trace):
        if destination and destination.resolve().is_relative_to(root.resolve()):
            parser.error("output and trace must be outside the synthetic checkout")
    # Exclusive creation is intentional: neither fixtures nor evidence may replace user files.
    root.mkdir(parents=True, exist_ok=False)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as report_file:
        if trace:
            trace.parent.mkdir(parents=True, exist_ok=True)
            trace.open("x").close()
        # Inherited Git routing/config/trace variables must not redirect this synthetic workload.
        env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
        env.update({
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Synthetic Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Synthetic Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        })
        if trace:
            env["GIT_TRACE2_PERF"] = str(trace)

        def git(*argv):
            return subprocess.run(
                ["git", "-C", str(root), *argv], env=env, check=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            ).stdout

        seed_started = time.perf_counter()
        git("init", "--initial-branch=main", "--template=")
        # Seed auto-GC would otherwise compete with the first measured samples.
        git("config", "gc.auto", "0")
        paths = []
        for index in range(args.files):
            file = root / str(index // 1000) / f"{index}.bin"
            file.parent.mkdir(exist_ok=True)
            file.write_bytes(random.Random(index).randbytes(args.file_bytes))
            paths.append(file)
            if index % 10_000 == 0:
                print(json.dumps({"seedingFiles": index}), flush=True)
        changed = root / "changed.txt"
        changed.write_text("before\n", encoding="utf-8")
        git("add", ".")
        git("-c", "commit.gpgSign=false", "commit", "-qm", "test: synthetic fixture")
        changed.write_text("after\n", encoding="utf-8")
        index_path = root / ".git" / "index"
        stale_index = index_path.read_bytes()
        for file in paths:
            os.utime(file, None)

        status_args = [
            "status", "--porcelain=v2", "--branch", "--no-ahead-behind",
            "--untracked-files=all", "--ignore-submodules=none", "--no-renames", "-z",
        ]
        raw_args = [
            "--literal-pathspecs", "diff", "-M", "--raw", "--numstat", "--no-color",
            "--no-ext-diff", "--no-textconv", "-z", "HEAD", "--",
        ]
        report = {
            "boundary": "native-git",
            "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "gitVersion": git("--version").decode().strip(),
            "platform": platform.platform(),
            "root": str(root),
            "trace": str(trace) if trace else None,
            "trackedFiles": args.files + 1,
            "inventoryBytes": args.files * args.file_bytes,
            "seedWallMs": (time.perf_counter() - seed_started) * 1000,
            "warmRounds": args.samples,
            "statusArgs": status_args,
            "rawArgs": raw_args,
            "hostLoadBefore": os.getloadavg(),
            "initialSamples": [],
            "samples": [],
        }
        expected_hashes = {}
        for round_index in range(args.samples + 1):
            arms = ["base-A", "base-A2", "managed"]
            if round_index % 2:
                arms.reverse()
            for arm in arms:
                index_path.write_bytes(stale_index)
                for phase in ("status", "raw", "next-status"):
                    argv = raw_args if phase == "raw" else (
                        ([] if arm == "managed" else ["--no-optional-locks"]) + status_args
                    )
                    before = resource.getrusage(resource.RUSAGE_CHILDREN)
                    started = time.perf_counter()
                    response = git(*argv)
                    elapsed_ms = (time.perf_counter() - started) * 1000
                    after = resource.getrusage(resource.RUSAGE_CHILDREN)
                    digest = hashlib.sha256(response).hexdigest()
                    expected = expected_hashes.setdefault(phase, digest)
                    if digest != expected:
                        raise RuntimeError(f"Git response changed for {arm}/{phase}/{round_index}")
                    row = {
                        "round": round_index, "arm": arm, "phase": phase,
                        "elapsedMs": elapsed_ms,
                        "cpuMs": ((after.ru_utime + after.ru_stime)
                                  - (before.ru_utime + before.ru_stime)) * 1000,
                        "bytes": len(response), "responseSha256": digest,
                    }
                    report["initialSamples" if round_index == 0 else "samples"].append(row)
                    print(json.dumps(row), flush=True)
                # Preserve completed arms if an expensive subsequent operation fails.
                report["hostLoadAfter"] = os.getloadavg()
                report_file.seek(0)
                json.dump(report, report_file, indent=2)
                report_file.truncate()
                report_file.flush()
        print(json.dumps({"output": str(output), "warmRounds": args.samples}), flush=True)


if __name__ == "__main__":
    main()
