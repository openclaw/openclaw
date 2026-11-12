#!/usr/bin/env python3
"""Synthetic, allowlisted benchmark receipts; never dump environment or credentials."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


def command(*args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=20, check=True)
    return result.stdout.strip()


def environment():
    result = {
        "system": platform.system(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "image": {k: os.environ.get(k) for k in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH")},
        "runner_name": os.environ.get("RUNNER_NAME"),
        "workflow_sha": os.environ.get("GITHUB_SHA"),
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "cache_policy": "off; separate exact-source checkouts and producer pnpm stores",
    }
    if platform.system() == "Darwin":
        result.update(os=command("sw_vers"), xcode=command("xcodebuild", "-version"),
                      swift=command("swift", "--version"),
                      hardware={k: command("sysctl", "-n", k) for k in
                                ("hw.model", "hw.machine", "hw.logicalcpu", "hw.physicalcpu", "hw.memsize")})
        roots = {"swiftpm": Path.home()/"Library/Caches/org.swift.swiftpm",
                 "swift_build": Path("apps/macos/.build"),
                 "node_modules": Path("node_modules")}
        result["cache_occupancy"] = {k: p.exists() and any(p.iterdir()) for k,p in roots.items()}
    else:
        result["os"] = platform.release()
        result["memory"] = next(line for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemTotal:"))
    return result


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024*1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    action, arm, *args = sys.argv[1:]
    target = Path(os.environ["FRV_CONTROL"])/(("producer-" if action == "producer" else "")+arm+".json")
    record = json.loads(target.read_text()) if target.exists() else {"arm":arm}
    if action in ("capture", "configured", "producer"):
        sha, = args
        actual = command("git", "rev-parse", "HEAD")
        if sha != actual:
            raise RuntimeError("Source revision does not match assigned arm")
        record.update(source_sha=sha, environment=environment())
        record["source_workflow_sha256"] = digest(Path(".github/workflows/ci.yml"))
        record["lockfile_sha256"] = digest(Path("pnpm-lock.yaml"))
        if action == "capture":
            record["initial_environment"] = record["environment"]
        if action == "configured":
            record["node"] = command("node", "--version")
            record["pnpm"] = command("pnpm", "--version")
        if action == "producer":
            archive = Path(".artifacts/macos-native-runtime/runtime.tgz")
            record.update(archive_bytes=archive.stat().st_size, archive_sha256=digest(archive),
                          producer_source_seconds=time.time()-float(os.environ["FRV_ARM_START"]))
            # Keep both arm receipts across the second source checkout.
            for k in ("GITHUB_OUTPUT",):
                if k in os.environ:
                    with open(os.environ[k],"a") as f:
                        f.write("archive-bytes="+str(record["archive_bytes"])+"\n")
    elif action == "finish":
        archive = Path(".artifacts/macos-native-runtime/runtime.tgz")
        if arm != "producer" and archive.exists():
            record.update(restored_archive_bytes=archive.stat().st_size, restored_archive_sha256=digest(archive))
        record.setdefault("environment", environment())
        record.update(observed_job_status=os.environ.get("FRV_JOB_STATUS"),
                      observed_required_outcomes=json.loads(os.environ.get("FRV_REQUIRED_OUTCOMES", "{}")),
                      elapsed_through_receipt_seconds=time.time()-float(os.environ["FRV_JOB_START"]))
    else:
        raise ValueError("Expected capture, configured, producer, or finish")
    target.write_text(json.dumps(record,indent=2)+"\n")


if __name__ == "__main__":
    main()
