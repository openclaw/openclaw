#!/usr/bin/env python3
"""Temporary native command boundary observations; no output piping or deadline changes."""
import argparse
from datetime import datetime, timezone
import json
import os
import signal
import subprocess
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--events", required=True)
    p.add_argument("--label", required=True)
    p.add_argument("command", nargs=argparse.REMAINDER)
    args = p.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        p.error("command is required")
    if args.label == "xcrun":
        label = ":".join(command[1:4])
    elif args.label == "xcodebuild":
        label = "showBuildSettings" if "-showBuildSettings" in command else command[-1]
    else:
        label = args.label
    start = time.monotonic_ns()
    # Events are bounded command metadata, never complete environment or test message contents.
    def record(phase, **extra):
        event = {"label": label, "phase": phase, "pid": os.getpid(),
                 "utc": datetime.now(timezone.utc).isoformat(),
                 "monotonic_ns": time.monotonic_ns(), **extra}
        with open(args.events, "a") as f:
            f.write(json.dumps(event, separators=(",", ":")) + "\n")
            f.flush()
    record("start")
    child = None
    pending = []
    def forward(sig, _frame):
        if child is None:
            pending.append(sig)
        elif child.poll() is None:
            child.send_signal(sig)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    try:
        # Keep original process group and inherit all standard descriptors unchanged.
        child = subprocess.Popen(command)
        for sig in pending:
            child.send_signal(sig)
        code = child.wait()
    except OSError as exc:
        record("end", exit_code=127, error_type=type(exc).__name__, elapsed_ns=time.monotonic_ns()-start)
        return 127
    record("end", exit_code=code, elapsed_ns=time.monotonic_ns()-start)
    if code < 0:
        signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
