#!/usr/bin/env python3
"""Small benchmark receipt: observe job-owned environment, never reset shared state."""
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def capture():
    runtimes = json.loads(command("xcrun", "simctl", "list", "runtimes", "-j"))["runtimes"]
    devices = json.loads(command("xcrun", "simctl", "list", "devices", "-j"))["devices"]
    topology = Counter((runtime, device["name"]) for runtime, items in devices.items()
                       for device in items if device.get("isAvailable"))
    home = Path.home()
    roots = {"derived_data": home / "Library/Developer/Xcode/DerivedData",
             "swiftpm": home / "Library/Caches/org.swift.swiftpm", "cargo": home / ".cargo",
             "source_packages": Path("apps/ios/build/SourcePackages").resolve()}
    return {"arm": os.environ["FRV_ARM"], "source_sha": os.environ["FRV_SOURCE_SHA"],
            "captured_utc": datetime.now(timezone.utc).isoformat(),
            "runner_name": os.environ.get("RUNNER_NAME"), "runner_label": "xcode-27",
            "image": {key: os.environ.get(key) for key in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH")},
            "os": command("sw_vers"),
            "hardware": {key: command("sysctl", "-n", key) for key in ("hw.model", "hw.machine", "hw.physicalcpu", "hw.memsize")},
            "node": command("node", "--version"), "xcode": command("xcodebuild", "-version"),
            "load": command("uptime"),
            "runtimes": sorted((item["identifier"], item.get("version"), item.get("buildversion"), item.get("isAvailable")) for item in runtimes),
            "simulator_topology": sorted((runtime, name, count) for (runtime, name), count in topology.items()),
            "simulator_devices": devices,
            "cache_policy": "fresh Actions job; workflow cache restore/save disabled; no cross-arm products",
            "cache_roots": {key: {"path": str(path), "nonempty": path.is_dir() and any(path.iterdir())} for key, path in roots.items()},
            "home": str(home), "runner_temp": os.environ["RUNNER_TEMP"],
            "workspace": os.environ["GITHUB_WORKSPACE"]}


def compare(baseline, candidate):
    if baseline.get("arm") != "baseline" or candidate.get("arm") != "candidate":
        raise ValueError("Arm identity mismatch")
    if not baseline.get("native_complete") or not candidate.get("native_complete"):
        raise ValueError("Incomplete native arm; no valid comparison")
    fields = ("runner_label", "image", "os", "hardware", "node", "xcode", "runtimes", "simulator_topology", "cache_policy")
    differences = [key for key in fields if baseline[key] != candidate[key]]
    if {key: value["nonempty"] for key, value in baseline["cache_roots"].items()} != {key: value["nonempty"] for key, value in candidate["cache_roots"].items()}:
        differences.append("initial cache occupancy")
    if differences:
        raise ValueError("Material environment difference; reject comparison: " + ", ".join(differences))


if __name__ == "__main__":
    action, *paths = sys.argv[1:]
    target = Path(paths[0])
    if action == "capture":
        record = capture()
        target.write_text(json.dumps(record, indent=2) + "\n")
        if record["node"] != "v24.22.1" or record["xcode"] != "Xcode 27.1\nBuild version 27A9275":
            raise SystemExit("Pinned Node/Xcode mismatch; do not start native work")
    elif action == "finish":
        record = json.loads(target.read_text()) if target.exists() else {"native_complete": False}
        record.update(native_complete=os.environ.get("FRV_NATIVE_COMPLETE") == "true",
                      elapsed_setup_native_seconds=(time.monotonic_ns() - int(os.environ["FRV_ARM_START_NS"])) / 1e9,
                      finished_utc=datetime.now(timezone.utc).isoformat())
        target.write_text(json.dumps(record, indent=2) + "\n")
    elif action == "compare":
        compare(json.loads(target.read_text()), json.loads(Path(paths[1]).read_text()))
        print("Both arms completed under matching recorded material conditions. Mechanism screen only; no performance claim.")
    else:
        raise SystemExit("Expected capture, finish or compare")
