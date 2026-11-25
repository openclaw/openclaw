"""Compare the runner's pinned hashFiles bundle with the transform fingerprint."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--runner-bundle", required=True, type=Path)
parser.add_argument("--node", default="node")
parser.add_argument("--samples", default=5, type=int)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
if sys.platform != "linux" or args.samples < 5 or args.output.exists():
    parser.error("Linux, at least five pairs, and a new output path are required")
bundle = args.runner_bundle.resolve()
runner_digest = "fbcad57b299a699a29f1c750949073d2b9c7ad4b3b742ca3355947f99fcf7e56"
if hashlib.sha256(bundle.read_bytes()).hexdigest() != runner_digest:
    parser.error("use actions/runner v2.338.2 src/Misc/layoutbin/hashFiles/index.js")
source = Path.cwd().resolve()
helper = source / ".github/actions/setup-node-env/transform-fingerprint.mjs"
revision = subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
patterns = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "**/package.json", "**/tsconfig*.json",
            "**/vitest*.config.*", "test/vitest/**", "src/state/*.sql",
            "!test/vitest/vitest.database-worker-core-paths.mjs",
            "!test/vitest/vitest.extension-database-workers-paths.mjs",
            "!test/vitest/vitest.ui-e2e.config.ts", "!test/vitest/vitest.unit-fast-paths.mjs",
            "!**/node_modules/**", "!.ci-harness/**"]
rows = []
with tempfile.TemporaryDirectory(prefix="transform-fingerprint-measure-") as scratch:
    root = Path(scratch)
    workspace = root / "source"
    workspace.mkdir()
    # Export only committed source: the real action fingerprints before restoring
    # dependencies. Hydrated node_modules would exaggerate the baseline cost.
    archive = subprocess.Popen(["git", "archive", revision], stdout=subprocess.PIPE)
    with tarfile.open(fileobj=archive.stdout, mode="r|") as contents:
        contents.extractall(workspace, filter="data")
    if archive.wait():
        raise RuntimeError("source export failed")
    env = {"PATH": os.environ["PATH"], "GITHUB_WORKSPACE": str(workspace),
           "patterns": "\n".join(patterns)}
    expected = None
    for sample in range(-1, args.samples):  # One excluded warm-up per arm; then ABAB.
        for variant, script in (("hashFiles", bundle), ("dirents", helper)):
            metrics = root / "time"
            load = os.getloadavg()
            started = time.perf_counter()
            result = subprocess.run(["/usr/bin/time", "-f", "%U %S %M", "-o", str(metrics),
                                     args.node, str(script)], cwd=workspace, env=env, capture_output=True)
            seconds = time.perf_counter() - started
            if result.returncode:
                raise RuntimeError(f"{variant} failed: {result.stderr.decode(errors='replace')[-1500:]}")
            if variant == "hashFiles":
                match = re.search(rb"__OUTPUT__(.*?)__OUTPUT__", result.stderr)
                if not match:
                    raise RuntimeError("runner did not emit a digest")
                digest = match[1].decode()
            else:
                digest = result.stdout.decode().strip()
            if expected is None:
                expected = digest
            if digest != expected:
                raise RuntimeError("cache generations differ")
            user, system, rss = map(float, metrics.read_text().split())
            row = dict(sample=sample, variant=variant, seconds=seconds, cpu=user + system,
                       peakRssKiB=rss, digest=digest, load=load)
            if sample >= 0:
                rows.append(row)
            print(json.dumps(row), flush=True)
report = dict(scope="fresh Node processes; warm filesystem; committed source before dependency restore; no Git metadata",
              revision=revision, runnerVersion="2.338.2", runnerBundleSha256=runner_digest,
              helperSha256=hashlib.sha256(helper.read_bytes()).hexdigest(),
              node=subprocess.check_output([args.node, "--version"]).decode().strip(),
              cpus=os.cpu_count(), affinity=sorted(os.sched_getaffinity(0)),
              hostRamBytes=os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
              cgroups={name: Path(f"/sys/fs/cgroup/{name}").read_text().strip()
                       if Path(f"/sys/fs/cgroup/{name}").exists() else None
                       for name in ("cpu.max", "memory.max")}, rows=rows)
args.output.write_text(json.dumps(report, indent=2) + "\n")
