#!/usr/bin/env python3
"""Measure a private CI store; never publish or modify shared caches."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time


workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
store = workspace / ".cache/openclaw-pnpm-store"
assert Path(os.environ["PNPM_CONFIG_STORE_DIR"]).resolve() == store
assert workspace == Path.cwd().resolve()
assert os.environ.get("GITHUB_ACTIONS") == "true"
scratch = Path(tempfile.mkdtemp(prefix="pnpm-store-probe-", dir=os.environ["RUNNER_TEMP"]))
pnpm = shutil.which("pnpm")
assert pnpm
# Keep the production installer, but reject its online repair before pnpm runs.
# COREPACK_ENABLE_NETWORK alone does not prevent pnpm registry requests.
offline_bin = scratch / "bin"
offline_bin.mkdir()
offline_pnpm = offline_bin / "pnpm"
offline_pnpm.write_text('''#!/bin/bash
set -euo pipefail
if [[ "$1" != "-v" && "${!#}" != "--offline" ]]; then
  echo "probe rejected a non-offline pnpm invocation" >&2
  exit 97
fi
exec "$PROBE_REAL_PNPM" "$@"
''')
offline_pnpm.chmod(0o700)


def command(arguments, **kwargs):
    subprocess.run(arguments, check=True, **kwargs)


def inventory():
    root = workspace / "node_modules/.pnpm"
    return {
        "packages": sorted(p.name for p in root.iterdir() if p.is_dir()),
        "lock": hashlib.sha256((root / "lock.yaml").read_bytes()).hexdigest(),
    }


def archive(name):
    path = scratch / f"{name}.tar.zst"
    command(["tar", "--use-compress-program=zstd -T0 -3", "-cf", str(path),
             "-C", str(workspace), ".cache/openclaw-pnpm-store"])
    result = {"bytes": path.stat().st_size, "path": str(path)}
    print("[store-probe] " + json.dumps({"archive": name, "bytes": result["bytes"]}), flush=True)
    return result


def clear_modules():
    # These are the same job-private importer roots cleared by normal CI repair.
    roots = [workspace / "node_modules", workspace / "ui/node_modules"]
    for family in ("packages", "extensions", "examples"):
        roots.extend((workspace / family).glob("*/node_modules"))
    for root in roots:
        if root.is_symlink():
            root.unlink()
        elif root.exists():
            shutil.rmtree(root)


expected = inventory()
source_lock = hashlib.sha256((workspace / "pnpm-lock.yaml").read_bytes()).hexdigest()
toolchain = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
             for p in (store / "toolchain").iterdir() if p.is_file()}
try:
    baseline = archive("baseline")
    started = time.monotonic()
    command(["pnpm", "--store-dir", str(store),
             "--config.cache-dir=" + str(store / "cache"), "store", "prune"])
    prune_seconds = time.monotonic() - started
    if toolchain != {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (store / "toolchain").iterdir() if p.is_file()}:
        raise RuntimeError("Pruning changed the authenticated bootstrap archives")
    candidate = archive("pruned")
    summary = {"baseline_bytes": baseline["bytes"], "candidate_bytes": candidate["bytes"],
               "prune_seconds": prune_seconds, "package_count": len(expected["packages"])}
    print("[store-probe] " + json.dumps(summary), flush=True)
    # Stop before repeated installs unless there is material payload waste.
    if candidate["bytes"] > baseline["bytes"] * 0.8:
        print("[store-probe] " + json.dumps({"verdict": "rejected_payload_screen"}), flush=True)
    else:
        samples = {"baseline": [], "pruned": []}
        for pair in range(6):
            for name, packed in (("baseline", baseline), ("pruned", candidate)):
                clear_modules()
                shutil.rmtree(store)
                usage_path = scratch / "time.txt"
                environment = {**os.environ, "PROBE_ARCHIVE": packed["path"],
                               "PATH": str(offline_bin) + os.pathsep + os.environ["PATH"],
                               "PROBE_REAL_PNPM": pnpm,
                               "COREPACK_ENABLE_NETWORK": "0", "DEPENDENCY_CACHE": "false",
                               "DEPENDENCY_CACHE_HIT": "true", "FROZEN_LOCKFILE": "true"}
                load = os.getloadavg()
                # Include extraction and the real CI install, with offline reconciliation.
                started = time.monotonic()
                result = subprocess.run(
                    ["/usr/bin/time", "-v", "-o", str(usage_path), "/bin/bash", "-euc",
                     'tar --use-compress-program="zstd -d" -xf "$PROBE_ARCHIVE"; '
                     'bash .github/actions/setup-node-env/install-dependencies.sh'],
                    env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                wall = time.monotonic() - started
                print(result.stdout, end="", flush=True)
                result.check_returncode()
                if "::warning::Cached dependency tree" in result.stdout or \
                   "::warning::Restored dependency store" in result.stdout:
                    raise RuntimeError("Offline reconciliation required a repair or online fallback")
                if inventory() != expected:
                    raise RuntimeError("Offline install changed the complete package inventory")
                if hashlib.sha256((workspace / "pnpm-lock.yaml").read_bytes()).hexdigest() != source_lock:
                    raise RuntimeError("Source lockfile changed")
                usage = {}
                for line in usage_path.read_text().splitlines():
                    if ": " in line:
                        key, value = line.strip().rsplit(": ", 1)
                        usage[key] = value
                row = {"pair": pair, "variant": name, "warmup": pair == 0, "wall": wall,
                       "cpu": float(usage["User time (seconds)"]) + float(usage["System time (seconds)"]),
                       "max_child_rss_kib": int(usage["Maximum resident set size (kbytes)"]), "load": load}
                print("[store-probe] " + json.dumps(row), flush=True)
                if pair:
                    samples[name].append(row)
            if pair:
                before, after = samples["baseline"][-1], samples["pruned"][-1]
                if any(after[key] >= before[key] * 1.2
                       for key in ("wall", "cpu", "max_child_rss_kib")) or \
                   (pair == 1 and after["wall"] > before["wall"] * 0.95):
                    print("[store-probe] " + json.dumps({"verdict": "rejected_timing_screen"}), flush=True)
                    break
        print("[store-probe] " + json.dumps({"samples": samples, "medians": {
            name: {key: statistics.median(row[key] for row in rows)
                   for key in ("wall", "cpu", "max_child_rss_kib")}
            for name, rows in samples.items()}}), flush=True)
finally:
    shutil.rmtree(scratch)
