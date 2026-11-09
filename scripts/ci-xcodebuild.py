#!/usr/bin/env python3
"""Report runner and simulator timing without changing the Xcode build."""
from datetime import datetime, timezone
import subprocess
import sys
import time


def stamp(message):
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    print(f"[ios-build] {timestamp} {message}", flush=True)


def diagnostic(label, command):
    started = time.monotonic()
    stamp(f"{label} start")
    try:
        result = subprocess.run(command, timeout=5, check=False)
        outcome = f"exit={result.returncode}"
    except subprocess.TimeoutExpired:
        outcome = "timed out after 5s; continuing build"
    except OSError as error:
        outcome = f"unavailable: {error.strerror}; continuing build"
    stamp(f"{label} end elapsed={time.monotonic() - started:.3f}s {outcome}")


if __name__ == "__main__":
    diagnostic("runner hardware", ["sysctl", "hw.ncpu", "hw.memsize", "hw.model"])
    diagnostic("booted simulators", ["xcrun", "simctl", "list", "devices", "booted"])
    started = time.monotonic()
    stamp("xcodebuild start")
    try:
        result = subprocess.run(["xcodebuild", *sys.argv[1:]], check=False)
        code = result.returncode if result.returncode >= 0 else 128 - result.returncode
    except OSError as error:
        print(f"::error::Unable to start xcodebuild: {error.strerror}", flush=True)
        code = 127
    stamp(f"xcodebuild end elapsed={time.monotonic() - started:.3f}s exit={code}")
    raise SystemExit(code)
