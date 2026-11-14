#!/usr/bin/env python3
"""Replay captured exec HOME decisions through real pnpm installs in a private sandbox.

Prerequisites: a disposable Docker sandbox with a writable btrfs workspace, its
privileged fixture container exposing that workspace, GNU time, the pinned pnpm,
and a trusted git archive of OpenClaw. The sandbox must already have its normal
workspace-HOME store warmed by one full install. No production data is needed.

Pass before/after JSON captures of resolvePreparedExecEnvironment as arrays of
{workdir, HOME}, with two different nested workdirs. The driver verifies the old
per-task HOME and new workspace HOME behavior before replaying those decisions.
It does not replace the owner's regression test or claim to invoke the exec tool.

Example (paths are inside the respective containers):
  python3 scripts/perf/sandbox-pnpm-home-measure.py \
    --sandbox task-sandbox --rig task-rig --source /evidence/source.tar \
    --rig-workspace /fixture/workspace --workspace /workspace \
    --before-capture /proof/owner-before.json --after-capture /proof/owner-after.json \
    --output /proof/home-series

Acceptance: five counterbalanced pairs after two baseline A/A controls; lower
written bytes per new task, no >=20% median CPU/time/RSS regression. Each task has
a fresh checkout; A gets a fresh private store, B reuses its sandbox-private store.
This is steady-state task creation, not a cold-store or cold-page-cache comparison.
Source extraction, sync, extent inspection, and deletion are outside install time.
All lifecycle scripts run. GNU time includes waited children; output blocks*512
measures process-attributed writes, not all btrfs kernel transaction traffic.
RSS is resident memory, NOT native allocation volume; allocation is unmeasured.
No agent database is opened, so padding a 35-GiB database would add no owner work.
Only newly created campaign task directories are removed; the sandbox store stays.
"""

import argparse
import hashlib
import json
import math
import pathlib
import statistics
import subprocess


def run(command):
    return subprocess.run(command, check=True, text=True, capture_output=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("sandbox", "rig", "source", "rig-workspace", "workspace",
                 "before-capture", "after-capture", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--uid", default="1000:1000")
    args = parser.parse_args()
    if args.pairs < 1:
        parser.error("--pairs must be positive")
    before_bytes = pathlib.Path(args.before_capture).read_bytes()
    after_bytes = pathlib.Path(args.after_capture).read_bytes()
    before, after = json.loads(before_bytes), json.loads(after_bytes)
    assert len(before) >= 2 and len(after) == len(before)
    assert len({row["workdir"] for row in before}) >= 2
    for old, new in zip(before, after):
        assert old["workdir"] == new["workdir"]
        assert old["HOME"] == old["workdir"]
        assert new["HOME"] == args.workspace
        assert old["workdir"].startswith(args.workspace.rstrip("/") + "/")

    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    rig = ["docker", "exec", args.rig]
    workspace = pathlib.PurePosixPath(args.workspace)
    rig_workspace = pathlib.PurePosixPath(args.rig_workspace)
    # mkdir without -p refuses to adopt any prior campaign directory.
    campaign_name = "pnpm-home-" + output.name
    assert campaign_name.replace("-", "").replace("_", "").isalnum()
    relative = pathlib.PurePosixPath(".openclaw/tmp") / campaign_name
    campaign = rig_workspace / relative
    run(rig + ["mkdir", str(campaign)])
    run(rig + ["chown", args.uid, str(campaign)])
    store = rig_workspace / ".local/share/pnpm/store"
    run(rig + ["test", "-d", str(store)])
    identity = {
        "beforeCaptureSha256": hashlib.sha256(before_bytes).hexdigest(),
        "afterCaptureSha256": hashlib.sha256(after_bytes).hexdigest(),
        "before": before, "after": after,
        "sourceSha256": run(rig + ["sha256sum", args.source]).strip(),
        "filesystem": run(rig + ["findmnt", "-T", str(rig_workspace)]),
        "storeBefore": run(rig + ["btrfs", "filesystem", "du", "-s", "--raw", str(store)]),
        "allocation": "unmeasured; peak RSS is not allocation volume",
        "args": vars(args),
    }
    (output / "identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    cells = [("AA1", "A"), ("AA2", "A")]
    for pair in range(1, args.pairs + 1):
        cells.extend((f"{arm}{pair}", arm) for arm in ("AB" if pair % 2 else "BA"))
    rows = []
    for label, arm in cells:
        task = campaign / label
        cwd = workspace / relative / label
        home = str(cwd if arm == "A" else workspace)
        run(["docker", "exec", "--user", args.uid, args.rig, "mkdir", str(task)])
        run(["docker", "exec", "--user", args.uid, args.rig, "tar", "xf", args.source,
             "--no-same-owner", "-C", str(task)])
        run(rig + ["btrfs", "filesystem", "sync", str(rig_workspace)])
        load = run(rig + ["cat", "/proc/loadavg"]).strip()
        command = ["docker", "exec", "--workdir", str(cwd), "--env", "HOME=" + home,
                   args.sandbox, "/usr/bin/time", "-f", "LANE_METRICS %e %U %S %M %O",
                   "pnpm", "install", "--frozen-lockfile"]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / (label + ".log")).write_text(result.stdout)
        if result.returncode:
            raise RuntimeError(f"{label} install failed ({result.returncode}); see its retained log")
        measurements = [line.split()[1:] for line in result.stdout.splitlines()
                        if line.startswith("LANE_METRICS ")]
        assert len(measurements) == 1, "Expected one GNU time result"
        wall, user, system, rss, blocks = measurements[0]
        run(rig + ["btrfs", "filesystem", "sync", str(rig_workspace)])
        row = {
            "label": label, "arm": arm, "control": label.startswith("AA"),
            "home": home, "wallSeconds": float(wall),
            "cpuSeconds": float(user) + float(system), "maxRssKiB": int(rss),
            "blockOutputBytes": int(blocks) * 512, "loadBefore": load,
            "nodeModulesExtents": run(rig + ["btrfs", "filesystem", "du", "-s", "--raw",
                                              str(task / "node_modules")]),
            "taskExtents": run(rig + ["btrfs", "filesystem", "du", "-s", "--raw", str(task)]),
            "command": command,
        }
        rows.append(row)
        with (output / "results.jsonl").open("a") as stream:
            stream.write(json.dumps(row) + "\n")
        print(json.dumps(row), flush=True)
        run(rig + ["rm", "-rf", str(task)])
        run(rig + ["btrfs", "filesystem", "sync", str(rig_workspace)])

    summary = {}
    for arm in "AB":
        selected = [row for row in rows if row["arm"] == arm and not row["control"]]
        summary[arm] = {"samples": len(selected)}
        for metric in ("wallSeconds", "cpuSeconds", "maxRssKiB", "blockOutputBytes"):
            values = sorted(row[metric] for row in selected)
            summary[arm][metric] = {
                "median": statistics.median(values), "min": values[0],
                "p95": values[math.ceil(len(values) * .95) - 1], "max": values[-1],
            }
    summary["controls"] = [row for row in rows if row["control"]]
    summary["regressionsAtLeast20Percent"] = [
        metric for metric in ("wallSeconds", "cpuSeconds", "maxRssKiB")
        if summary["B"][metric]["median"] >= summary["A"][metric]["median"] * 1.2
    ]
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    run(rig + ["rmdir", str(campaign)])
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
