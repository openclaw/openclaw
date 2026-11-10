"""Run one cold-compiler sample of the complete serial CI type tail on Linux.

Alternate this command between 4-CPU and 2-CPU Testboxes with identical source.
Sample zero is the excluded preparation run; collect samples 1 through 5.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--sample", type=int, required=True)
args = parser.parse_args()
if not Path("/proc/meminfo").exists():
    parser.error("Linux is required")

root = Path.cwd()
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
lock = hashlib.sha256((root / "pnpm-lock.yaml").read_bytes()).hexdigest()
graphs = ["extensions-test", "scripts"]
# These are the two selected graphs' generated incremental outputs, never source.
for name in graphs:
    (root / ".artifacts/tsgo-cache" / f"{name}.tsbuildinfo").unlink(missing_ok=True)

memory = []
stop = threading.Event()
def observe():
    while not stop.is_set():
        fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        memory.append(int(fields["MemAvailable"].split()[0]))
        stop.wait(0.1)

observer = threading.Thread(target=observe)
observer.start()
started = time.monotonic()
load = os.getloadavg()
def oom_kills():
    return int(dict(line.split() for line in Path("/proc/vmstat").read_text().splitlines())["oom_kill"])
oom_before = oom_kills()
try:
    with tempfile.TemporaryDirectory(prefix="central-types-measure-") as scratch:
        metrics = Path(scratch) / "time"
        command = ["node", "scripts/run-tsgo-core-test-shards.mjs", "--ci-graphs-json", json.dumps(graphs)]
        result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(metrics), *command],
                                env={**os.environ, "CI": "true", "OPENCLAW_LOCAL_CHECK": "0",
                                     "OPENCLAW_CI_STATIC_EVIDENCE": "1"},
                                capture_output=True, text=True)
        elapsed = time.monotonic() - started
        if result.returncode:
            raise RuntimeError(result.stdout[-3000:] + result.stderr[-3000:])
        user, system, rss = map(float, metrics.read_text().split())
finally:
    stop.set()
    observer.join()
print(json.dumps(dict(sample=args.sample, revision=revision, lockSha256=lock, graphs=graphs,
                      wallSeconds=elapsed, cpuSeconds=user + system, peakChildRssKiB=rss,
                      minAvailableKiB=min(memory), load=load, cpus=os.cpu_count(),
                      oomKills=oom_kills() - oom_before,
                      ramBytes=os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
                      affinity=sorted(os.sched_getaffinity(0))), sort_keys=True))
