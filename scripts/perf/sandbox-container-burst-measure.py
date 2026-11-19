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
--mode inspect-start includes the identity/running/read-only inspection before
each start. --skills-source mounts a synthetic tree read-only and verifies its
SKILL.md is readable and unwritable in every container outside the timed window.
Nested Linux fixtures without a user manager can select --cgroup-manager
cgroupfs; this does not qualify the production systemd scope path.
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
parser.add_argument("--mode", choices=["start", "inspect-start", "provision"], default="provision")
parser.add_argument("--image", default="docker.io/library/busybox:1.37.0")
parser.add_argument("--sessions", type=int, default=20)
parser.add_argument("--samples", type=int, default=5)
parser.add_argument("--limits", type=int, nargs="+", default=[20, 4, 8])
parser.add_argument("--scope", action="store_true")
parser.add_argument("--cgroup-manager", choices=["systemd", "cgroupfs"])
parser.add_argument("--skills-source", type=pathlib.Path, help="Synthetic tree containing SKILL.md, mounted read-only")
args = parser.parse_args()
root = args.root.resolve(strict=True)
assert os.getuid() != 0, "Run as a rootless user"
assert args.sessions > 0 and args.samples > 0 and all(n > 0 for n in args.limits)
assert all((root / "workspace" / f"session-{i}").is_dir() for i in range(args.sessions))
skills = args.skills_source.resolve(strict=True) if args.skills_source else None
skill_bytes = (skills / "SKILL.md").read_text() if skills else None
engine = [
    "podman", "--remote=false", "--root", str(root / "storage"),
    "--runroot", str(root / "runroot"), "--storage-driver=vfs",
    "--events-backend=file", "--hooks-dir", str(root / "hooks"),
]
if args.cgroup_manager:
    engine += ["--cgroup-manager", args.cgroup_manager]
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
        *(["--volume", f"{skills}:/skills:ro"] if skills else []),
        args.image, "sleep", "infinity",
    ]


retained = []


def sample(label, limit):
    ids = []
    command_timings = []
    lock = threading.Lock()
    active = peak = 0
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    own = resource.getrusage(resource.RUSAGE_SELF)
    start = time.monotonic()

    def command(argv):
        nonlocal active, peak
        native_start = time.monotonic()
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            return run(argv)
        finally:
            with lock:
                active -= 1
                command_timings.append({"command": argv[0],
                                        "nativeMs": 1000 * (time.monotonic() - native_start)})

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=limit) as native:
            def one(index):
                enter = time.monotonic()
                cid = retained[index] if retained else native.submit(command, create_args(index)).result()
                created = time.monotonic()
                with lock:
                    ids.append(cid)
                if args.mode == "inspect-start":
                    observed = native.submit(command, [
                        "inspect", "-f", "{{.Id}} {{.State.Running}} {{.HostConfig.ReadonlyRootfs}}", cid,
                    ]).result()
                    assert observed == f"{cid} false true", observed
                inspected = time.monotonic()
                native.submit(command, ["start", cid]).result()
                end = time.monotonic()
                return {"index": index, "readyMs": 1000 * (end - start),
                        "createWithQueueMs": 1000 * (created - enter),
                        "inspectWithQueueMs": 1000 * (inspected - created),
                        "startWithQueueMs": 1000 * (end - inspected)}

            with concurrent.futures.ThreadPoolExecutor(max_workers=args.sessions) as callers:
                rows = list(callers.map(one, range(args.sessions)))
        elapsed = 1000 * (time.monotonic() - start)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        own_after = resource.getrusage(resource.RUSAGE_SELF)
        assert len(ids) == args.sessions
        assert all(item["State"]["Running"] for item in json.loads(run(["inspect", *ids])))
        if skills:
            for cid in ids:
                assert run(["exec", cid, "cat", "/skills/SKILL.md"]) == skill_bytes.strip()
                assert run(["exec", cid, "sh", "-c",
                            "if printf forbidden >>/skills/SKILL.md 2>/dev/null; then exit 1; fi; printf readonly"]) == "readonly"
            assert (skills / "SKILL.md").read_text() == skill_bytes
        ready = sorted(row["readyMs"] for row in rows)
        print(json.dumps({
            "label": label, "mode": args.mode, "scoped": args.scope, "limit": limit,
            "readOnlySkillsVerified": bool(skills),
            "maxNativeConcurrency": peak,
            "nativeCommandCount": args.sessions * (2 if args.mode == "inspect-start" or not retained else 1),
            "wallMs": elapsed, "p50ReadyMs": statistics.median(row["readyMs"] for row in rows),
            "p90ReadyMs": ready[(len(ready) * 90 + 99) // 100 - 1],
            "p95ReadyMs": ready[(len(ready) * 95 + 99) // 100 - 1],
            "maxReadyMs": max(row["readyMs"] for row in rows),
            "nativeUserCpuMs": 1000 * (after.ru_utime - before.ru_utime),
            "nativeSystemCpuMs": 1000 * (after.ru_stime - before.ru_stime),
            "nativeCpuMs": 1000 * (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime),
            "driverCpuMs": 1000 * (own_after.ru_utime + own_after.ru_stime - own.ru_utime - own.ru_stime),
            "nativeCumulativeMaxRssKiB": after.ru_maxrss, "rows": rows,
            "commandTimings": command_timings,
        }), flush=True)
    finally:
        if retained:
            run(["kill", *retained])
            run(["wait", *retained])
        else:
            for cid in ids:
                run(["rm", "-f", cid])


try:
    if args.mode in ("start", "inspect-start"):
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
