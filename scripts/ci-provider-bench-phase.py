#!/usr/bin/env python3
"""Throwaway provider benchmark observer: PHASE COMMAND [ARGS...]."""

import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import tempfile
import time


INTERVAL_SECONDS = 20
CPU_FIELDS = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")


def probe(read):
    try:
        return read()
    except Exception as error:
        # Missing counters and processes exiting during a sample are diagnostic gaps.
        return {"unavailable": type(error).__name__}


def key_values(path):
    return {key: int(value) for key, value in (line.split() for line in path.read_text().splitlines())}


def cpu_sample():
    fields = Path("/proc/stat").read_text().splitlines()[0].split()
    if fields[0] != "cpu":
        raise ValueError("aggregate CPU line unavailable")
    return {"at": time.monotonic(), "ticks": [int(value) for value in fields[1:9]]}


def cpu_delta(previous, current):
    if "unavailable" in current or "unavailable" in previous:
        return {"unavailable": "CPU sample unavailable"}
    elapsed = current["at"] - previous["at"]
    ticks = [b - a for a, b in zip(previous["ticks"], current["ticks"])]
    total = sum(ticks)
    if elapsed <= 0 or total <= 0 or min(ticks) < 0:
        return {"unavailable": "No valid CPU interval"}
    busy = total - ticks[3] - ticks[4] - ticks[7]
    return {
        "scope": "all CPUs visible in /proc/stat; not process CPU usage",
        "interval_seconds": round(elapsed, 3),
        "ticks": dict(zip(CPU_FIELDS, ticks)),
        "busy_percent": round(100 * busy / total, 3),
        "busy_vcpus": round(busy / os.sysconf("SC_CLK_TCK") / elapsed, 3),
        "iowait_percent": round(100 * ticks[4] / total, 3),
        "steal_percent": round(100 * ticks[7] / total, 3),
    }


def memory():
    wanted = {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}
    values = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in wanted:
            values[key + "_bytes"] = int(value.split()[0]) * 1024
    return values


def pressure(kind):
    result = {}
    for line in Path("/proc/pressure", kind).read_text().splitlines():
        name, *values = line.split()
        result[name] = {
            key: int(value) if key == "total" else float(value)
            for key, value in (entry.split("=", 1) for entry in values)
        }
    return result


def cgroup():
    relative = next(
        line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::")
    )
    root = Path("/sys/fs/cgroup")
    directory = root / relative.lstrip("/")
    mapping = "matched /proc/self/cgroup"
    if not (directory / "cgroup.controllers").exists():
        # A cgroup namespace can mount the observer's group directly at the root.
        directory = root
        mapping = "mount-root fallback; exact observer group mapping unverified"
    result = {"scope": "observer cgroup v2; child initially inherits this group", "mapping": mapping}
    for name in ("memory.current", "memory.peak", "memory.max"):
        result[name] = probe(lambda name=name: (directory / name).read_text().strip())
    for name in ("memory.events", "cpu.stat"):
        result[name] = probe(lambda name=name: key_values(directory / name))
    return result


def disk(path):
    values = os.statvfs(path)
    return {
        "total_bytes": values.f_blocks * values.f_frsize,
        "available_bytes": values.f_bavail * values.f_frsize,
        "available_inodes": values.f_favail,
    }


def node_processes():
    count = rss_kib = threads = vanished = 0
    for directory in Path("/proc").iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            if (directory / "exe").resolve().name not in ("node", "nodejs"):
                continue
            fields = {}
            for line in (directory / "status").read_text().splitlines():
                key, value = line.split(":", 1)
                if key in ("VmRSS", "Threads"):
                    fields[key] = int(value.split()[0])
            count += 1
            rss_kib += fields.get("VmRSS", 0)
            threads += fields.get("Threads", 0)
        except (OSError, ValueError):
            vanished += 1
    return {
        "scope": "visible processes with node/nodejs executables; RSS sum is not PSS",
        "processes": count,
        "rss_bytes": rss_kib * 1024,
        "threads": threads,
        "unreadable_or_exited_processes": vanished,
    }


def emit(value):
    try:
        print("BENCH_METRIC " + json.dumps(value, separators=(",", ":")), flush=True)
    except OSError:
        # A closed log stream must not change the workload's result.
        pass


def child_usage():
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "ru_maxrss": usage.ru_maxrss,
        "ru_maxrss_unit": "bytes" if sys.platform == "darwin" else "KiB",
        "scope": "RUSAGE_CHILDREN maximum RSS; not summed concurrent child peak RSS",
        "user_cpu_seconds": usage.ru_utime,
        "system_cpu_seconds": usage.ru_stime,
    }


def main():
    if len(sys.argv) < 3:
        print("usage: ci-provider-bench-phase.py PHASE COMMAND [ARGS...]", file=sys.stderr)
        return 2
    phase = sys.argv[1]
    started = time.monotonic()
    previous_cpu = probe(cpu_sample)
    child = None
    pending_signals = []

    def forward(signum, _frame):
        if child is None:
            pending_signals.append(signum)
        elif child.poll() is None:
            child.send_signal(signum)

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, forward)

    def sample(final=False):
        nonlocal previous_cpu
        current_cpu = probe(cpu_sample)
        metric = {
            "phase": phase,
            "time_unix": time.time(),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "final": final,
            "cpu": probe(lambda: cpu_delta(previous_cpu, current_cpu)),
            "memory": probe(memory),
            "cgroup": probe(cgroup),
            "pressure": {kind: probe(lambda kind=kind: pressure(kind)) for kind in ("cpu", "memory", "io")},
            "workspace_disk": probe(lambda: disk(os.getcwd())),
            "tmp_disk": probe(lambda: disk(tempfile.gettempdir())),
            "node_processes": probe(node_processes),
        }
        previous_cpu = current_cpu
        if final:
            metric["children_rusage"] = probe(child_usage)
        emit(metric)

    sample()
    try:
        child = subprocess.Popen(sys.argv[2:])
    except OSError as error:
        emit({"phase": phase, "launch_error": type(error).__name__, "errno": error.errno})
        return 127 if isinstance(error, FileNotFoundError) else 126
    for signum in pending_signals:
        if child.poll() is None:
            child.send_signal(signum)
    while True:
        try:
            result = child.wait(timeout=INTERVAL_SECONDS)
            break
        except subprocess.TimeoutExpired:
            sample()
    sample(final=True)
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    sys.exit(main())
