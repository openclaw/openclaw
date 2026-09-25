#!/usr/bin/env python3
"""Measure frozen baseline/candidate binaries in alternating order."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess


ROOT = Path(os.environ.get("RFC54_BENCH_ROOT", Path(__file__).parent))
SCRIPTS = Path(__file__).parent
BINARIES = ["bin/baseline-swift", "bin/candidate-swift", "bin/openclaw-mac-node-sidecar"]
METRICS = [
    "p50Ms", "p95Ms", "p99Ms", "throughputPerSecond",
    "cpuSeconds", "rssBeforeKiB", "rssAfterKiB",
]


def binary_hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in BINARIES}


def write_json(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2) + "\n")


def activity():
    rows = subprocess.check_output(["/bin/ps", "-axo", "pid=,%cpu=,comm="], text=True)
    parsed = []
    for line in rows.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            try:
                parsed.append({
                    "pid": int(parts[0]),
                    "cpuPercent": float(parts[1]),
                    "process": Path(parts[2]).name,
                })
            except ValueError:
                continue
    return {
        "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "loadAverage": os.getloadavg(),
        "topCPU": sorted(parsed, key=lambda row: row["cpuPercent"], reverse=True)[:15],
    }


def summarize(pairs, hashes):
    summary = []
    for size in [256, 4096]:
        for concurrency in [1, 8]:
            cell = {"payloadBytes": size, "concurrency": concurrency}
            for variant in ["baseline", "candidate"]:
                runs = [
                    next(
                        run for run in pair[variant]["results"]
                        if run["payloadBytes"] == size and run["concurrency"] == concurrency
                    )
                    for pair in pairs
                ]
                cell[variant] = {
                    key: statistics.median(run[key] for run in runs) for key in METRICS
                }
                cell[variant]["individualP95Ms"] = [run["p95Ms"] for run in runs]
            cell["candidateVsBaseline"] = {
                key: cell["candidate"][key] / cell["baseline"][key]
                for key in ["p50Ms", "p95Ms", "throughputPerSecond", "cpuSeconds", "rssAfterKiB"]
            }
            summary.append(cell)
    startup = {}
    for variant in ["baseline", "candidate"]:
        runs = [run for pair in pairs for run in pair[variant]["results"]]
        startup[variant] = {
            key: {
                "median": statistics.median(run["ready"][key] for run in runs),
                "p95": sorted(run["ready"][key] for run in runs)[18],
                "samples": len(runs),
            }
            for key in ["connectedMs", "processReadyMs"]
        }
    result = {
        "binaries": hashes,
        "workloads": summary,
        "startup": startup,
        "summaryRule": (
            "Median of five per-run percentile/throughput/resource summaries. "
            "5 x 2000 measured plus 100 warmup invocations per workload per variant. "
            "20 process startup samples per variant. Binaries frozen for the entire run."
        ),
    }
    write_json("paired-summary.json", result)
    print(json.dumps(result, indent=2), flush=True)


def main():
    hashes = binary_hashes()
    activity_log = []
    pairs = []
    for repetition in range(5):
        pair = {}
        order = ["baseline", "candidate"] if repetition % 2 == 0 else ["candidate", "baseline"]
        for variant in order:
            if hashes != binary_hashes():
                raise RuntimeError("Binary changed during the paired run")
            label = f"paired-{variant}-{repetition}"
            env = os.environ.copy()
            extra = [str(ROOT / "bin/openclaw-mac-node-sidecar")] if variant == "candidate" else []
            env["RFC54_BENCH_EXTRA_ARGS"] = json.dumps(extra)
            activity_log.append({"label": label, "phase": "before", **activity()})
            run = subprocess.run(
                ["node", str(SCRIPTS / "run-bench.cjs"), str(ROOT / f"bin/{variant}-swift"),
                 label, "1", "2000"],
                env=env, cwd=ROOT, capture_output=True, text=True,
            )
            activity_log.append({"label": label, "phase": "after", **activity()})
            write_json("host-activity.json", activity_log)
            (ROOT / f"{label}.log").write_text(run.stdout + run.stderr)
            if run.returncode:
                raise RuntimeError(run.stdout + run.stderr)
            pair[variant] = json.loads((ROOT / f"{label}-results.json").read_text())
            print(f"{label}: 4 workloads complete", flush=True)
        pairs.append(pair)
        write_json("paired-raw.json", {"binaries": hashes, "pairs": pairs})
    summarize(pairs, hashes)


if __name__ == "__main__":
    main()
