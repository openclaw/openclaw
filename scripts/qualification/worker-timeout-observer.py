"""Disposable external observer: no argv, env, fd targets or test payloads recorded."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def read(path):
    try:
        with open(path) as handle:
            return handle.read(16384)
    except (OSError, UnicodeError):
        return None


def processes(root_pid):
    found = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        raw = read("/proc/" + name + "/stat")
        if not raw:
            continue
        fields = raw[raw.rfind(") ") + 2:].split()
        if len(fields) < 22:
            continue
        found[int(name)] = dict(pid=int(name), ppid=int(fields[1]), state=fields[0],
            userTicks=int(fields[11]), systemTicks=int(fields[12]),
            threads=int(fields[17]), startTicks=int(fields[19]),
            rssBytes=int(fields[21]) * os.sysconf("SC_PAGE_SIZE"))
    selected = {root_pid}
    for _ in range(16):
        added = {pid for pid, info in found.items() if info["ppid"] in selected}
        if added.issubset(selected):
            break
        selected.update(added)
    return [found[pid] for pid in sorted(selected) if pid in found][:256]


def snapshot(root_pid, directory):
    cgroup = (read("/proc/self/cgroup") or "").splitlines()
    relative = next((line[3:] for line in cgroup if line.startswith("0::")), None)
    groups = []
    if relative is not None:
        root = Path("/sys/fs/cgroup")
        current = root / relative.lstrip("/")
        for depth in range(8):
            groups.append(dict(depth=depth, **{name: read(current / name) for name in
                ("cpu.stat", "cpu.max", "memory.current", "memory.max", "memory.events",
                 "memory.stat", "cpu.pressure", "memory.pressure", "io.pressure")}))
            if current == root:
                break
            current = current.parent
    return dict(at=time.time_ns() // 1000000, monotonicNs=time.monotonic_ns(),
        ticksPerSecond=os.sysconf("SC_CLK_TCK"),
        processes=processes(root_pid), cgroups=groups,
        synchronousWaits=[read(file) for file in sorted(directory.glob("synchronous-wait-*.json"))[:16]],
        hostCpu=(read("/proc/stat") or "").splitlines()[:1],
        hostPressure={name: read("/proc/pressure/" + name) for name in ("cpu", "memory", "io")})


def main():
    directory = Path(os.environ["OPENCLAW_QUALIFICATION_DIR"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    plan_path = Path(__file__).with_name("worker-timeout-group.json")
    env = dict(os.environ, OPENCLAW_NODE_TEST_GROUPS_JSON=plan_path.read_text())
    child = subprocess.Popen(["node", "--import", "tsx", "scripts/ci-run-node-test-shard.mts"], env=env)
    # stdout/stderr are inherited: observers do not keep the test watchdog alive.
    with open(directory / "resources.jsonl", "w", buffering=1) as output:
        while True:
            try:
                output.write(json.dumps(snapshot(child.pid, directory), separators=(",", ":")) + "\n")
            except (OSError, ValueError) as error:
                output.write(json.dumps(dict(at=time.time_ns() // 1000000,
                    observerError=type(error).__name__)) + "\n")
            code = child.poll()
            if code is not None:
                return code if code >= 0 else 128 - code
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
