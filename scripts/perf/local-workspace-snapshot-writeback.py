#!/usr/bin/env python3
"""Synthetic btrfs snapshot/writeback probe; use only a new, private btrfs root."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import resource
import subprocess
import time


def run(*argv):
    subprocess.run(argv, check=True, stdout=subprocess.DEVNULL)


def cpu_ms():
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return 1000 * (own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime)


def dirty_kib():
    return {
        name: int(value.split()[0])
        for line in Path("/proc/meminfo").read_text().splitlines()
        for name, value in [line.split(":", 1)]
        if name in ("Dirty", "Writeback")
    }


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--files", type=int, default=62000)
parser.add_argument("--file-bytes", type=int, default=17742)
parser.add_argument("--samples", type=int, default=10)
parser.add_argument("--interval", type=float, default=5)
parser.add_argument("--bytes-per-hour", type=int, default=1_700_000_000)
args = parser.parse_args()
assert min(args.files, args.file_bytes, args.samples, args.interval) > 0
args.root.mkdir()  # Refuse an existing fixture or an operator-owned directory.
source = args.root / "source"
run("btrfs", "subvolume", "create", str(source))
payload = os.urandom(args.file_bytes)
paths = [source / f"file-{index}.bin" for index in range(args.files)]
for pathname in paths:
    pathname.write_bytes(payload)
descriptor = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
libc = ctypes.CDLL(None, use_errno=True)
libc.syncfs.argtypes = [ctypes.c_int]
libc.syncfs.restype = ctypes.c_int


def syncfs():
    if libc.syncfs(descriptor):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def measure(label, index, write_bytes, presync):
    syncfs()  # Each sample starts with the same clean baseline, outside timing.
    began = time.monotonic()
    remaining = write_bytes
    for pathname in paths:
        if not remaining:
            break
        count = min(remaining, args.file_bytes)
        with pathname.open("r+b") as output:
            output.write(payload[:count])
        remaining -= count
    assert remaining == 0
    written = time.monotonic()
    dirty_before = dirty_kib()
    before_sync = time.monotonic()
    if presync:
        syncfs()
    synced = time.monotonic()
    target = args.root / f"capture-{label}-{index}"
    trace = args.root / f"{label}-{index}.strace"
    cpu_before = cpu_ms()
    run("strace", "-qq", "-tt", "-T", "-e", "trace=ioctl,fsync,fdatasync,syncfs",
        "-o", str(trace), "btrfs", "subvolume", "snapshot", str(source), str(target))
    captured = time.monotonic()
    capture_cpu = cpu_ms() - cpu_before
    dirty_after = dirty_kib()
    paths[-1].write_bytes(b"changed after snapshot")
    assert (target / paths[-1].name).read_bytes() == payload
    paths[-1].write_bytes(payload)
    remove_started = time.monotonic()
    run("btrfs", "subvolume", "delete", str(target))
    result = {
        "regime": label, "sample": index, "presync": presync,
        "writeBytes": write_bytes, "writeMs": 1000 * (written - began),
        "syncfsMs": 1000 * (synced - before_sync),
        "snapshotMs": 1000 * (captured - synced), "snapshotCpuMs": capture_cpu,
        "removeMs": 1000 * (time.monotonic() - remove_started),
        "dirtyBeforeKiB": dirty_before, "dirtyAfterKiB": dirty_after,
        "load": os.getloadavg(), "trace": str(trace), "isolation": "passed",
    }
    print(json.dumps(result), flush=True)
    if label == "steady":
        time.sleep(max(0, began + args.interval - time.monotonic()))


try:
    print(json.dumps({"source": str(source), "files": args.files,
                      "bytes": args.files * args.file_bytes,
                      "bytesPerHour": args.bytes_per_hour, "interval": args.interval,
                      "accounting": "Dirty/Writeback are whole-kernel observations; CPU includes child tools"}), flush=True)
    for index in range(2):
        measure("control", index, 0, False)
    for index in range(args.samples):
        # Counterbalance pre-syncfs to identify where writeback wait moves.
        for presync in ([False, True] if index % 2 == 0 else [True, False]):
            measure("steady", index * 2 + int(presync),
                    round(args.bytes_per_hour * args.interval / 3600), presync)
    for index in range(5):
        for presync in ([False, True] if index % 2 == 0 else [True, False]):
            measure("burst", index * 2 + int(presync), args.files * args.file_bytes, presync)
finally:
    os.close(descriptor)
    run("btrfs", "subvolume", "delete", str(source))
