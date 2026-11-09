"""Measure a resumed-container burst against a task-private rootless Podman store.

Prepare ROOT/{home,tmp,storage,runroot,hooks,workspace}; put one synthetic btrfs
snapshot at ROOT/workspace/session-N for each session. Pull IMAGE into the private
VFS store before timing. Run as the existing rootless user with its user bus and
XDG_RUNTIME_DIR, HOME=ROOT/home, TMPDIR=ROOT/tmp, and nice/ionice on an isolated rig.
Never use production state or the default engine store.

Example: python3 scripts/perf/sandbox-container-burst-measure.py ROOT --scope
Two concurrency-20 A/A controls precede five counterbalanced 20/4/8 triplets.
--mode start measures restarting existing containers; provision measures create
plus start. --scope matches the Gateway's per-command systemd scope launcher.
Each sample verifies all containers running; cleanup removes only captured IDs.
CPU covers waited native commands, not detached conmon cleanup. Maximum RSS is
a cumulative process high-water mark, not allocation. No database or JS runtime
is exercised, and this driver alone cannot qualify full-Gateway readiness.
"""

import argparse
import concurrent.futures
import json
import os
import pathlib
import resource
import statistics
import subprocess
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=pathlib.Path)
parser.add_argument("--mode", choices=["start", "provision"], default="provision")
parser.add_argument("--image", default="docker.io/library/busybox:1.37.0")
parser.add_argument("--sessions", type=int, default=20)
parser.add_argument("--samples", type=int, default=5)
parser.add_argument("--limits", type=int, nargs="+", default=[20, 4, 8])
parser.add_argument("--scope", action="store_true")
args = parser.parse_args()
root = args.root.resolve(strict=True)
assert os.getuid() != 0, "Run as a rootless user with an existing systemd user manager"
assert args.sessions > 0 and args.samples > 0 and all(n > 0 for n in args.limits)
assert all((root / "workspace" / f"session-{i}").is_dir() for i in range(args.sessions))
engine = [
    "podman", "--remote=false", "--root", str(root / "storage"),
    "--runroot", str(root / "runroot"), "--storage-driver=vfs",
    "--events-backend=file", "--hooks-dir", str(root / "hooks"),
]
if args.scope:
    engine = [
        "systemd-run", "--user", "--scope", "--quiet", "--collect",
        "--expand-environment=no", "--description=OpenClaw-sandbox-runtime", "--",
    ] + engine


def run(argv):
    result = subprocess.run(engine + argv, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def create_args(index):
    return [
        "create", "--init", "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--userns=keep-id", "--volume",
        f"{root}/workspace/session-{index}:/workspace", "--workdir=/workspace",
        args.image, "sleep", "infinity",
    ]


retained = []


def sample(label, limit):
    ids = []
    lock = threading.Lock()
    active = peak = 0
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    own = resource.getrusage(resource.RUSAGE_SELF)
    start = time.monotonic()

    def command(argv):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            return run(argv)
        finally:
            with lock:
                active -= 1

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=limit) as native:
            def one(index):
                enter = time.monotonic()
                cid = retained[index] if retained else native.submit(command, create_args(index)).result()
                created = time.monotonic()
                with lock:
                    ids.append(cid)
                native.submit(command, ["start", cid]).result()
                end = time.monotonic()
                return {"index": index, "readyMs": 1000 * (end - start),
                        "createWithQueueMs": 1000 * (created - enter),
                        "startWithQueueMs": 1000 * (end - created)}

            with concurrent.futures.ThreadPoolExecutor(max_workers=args.sessions) as callers:
                rows = list(callers.map(one, range(args.sessions)))
        elapsed = 1000 * (time.monotonic() - start)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        own_after = resource.getrusage(resource.RUSAGE_SELF)
        assert len(ids) == args.sessions
        assert all(item["State"]["Running"] for item in json.loads(run(["inspect", *ids])))
        print(json.dumps({
            "label": label, "mode": args.mode, "scoped": args.scope, "limit": limit,
            "maxNativeConcurrency": peak, "nativeCommandCount": args.sessions * (1 if retained else 2),
            "wallMs": elapsed, "p50ReadyMs": statistics.median(row["readyMs"] for row in rows),
            "maxReadyMs": max(row["readyMs"] for row in rows),
            "nativeUserCpuMs": 1000 * (after.ru_utime - before.ru_utime),
            "nativeSystemCpuMs": 1000 * (after.ru_stime - before.ru_stime),
            "nativeCpuMs": 1000 * (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime),
            "driverCpuMs": 1000 * (own_after.ru_utime + own_after.ru_stime - own.ru_utime - own.ru_stime),
            "nativeCumulativeMaxRssKiB": after.ru_maxrss, "rows": rows,
        }), flush=True)
    finally:
        if retained:
            run(["kill", *retained])
            run(["wait", *retained])
        else:
            for cid in ids:
                run(["rm", "-f", cid])


try:
    if args.mode == "start":
        for index in range(args.sessions):
            retained.append(run(create_args(index)))
    sample("AA-1", args.sessions)
    sample("AA-2", args.sessions)
    for pair in range(args.samples):
        for limit in args.limits if pair % 2 == 0 else reversed(args.limits):
            sample(f"pair-{pair + 1}-{limit}", limit)
finally:
    for cid in retained:
        run(["rm", "-f", cid])
