"""Compare security harness preparation with a local origin, not WAN latency."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

paths = (".github/actions", ".github/zizmor.yml", "scripts/detect-private-keys.mts",
         "scripts/ci-production-audit.mjs", "scripts/ci-collect-checks.sh")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkout-action", required=True, type=Path)
parser.add_argument("--action-node", default="node")
parser.add_argument("--samples", default=5, type=int)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
if sys.platform != "linux":
    parser.error("Linux with GNU /usr/bin/time is required")
if args.samples < 5 or args.output.exists():
    parser.error("at least five pairs and a new output path are required")
action = args.checkout_action.resolve()
if action.parent.parent.name != "3d3c42e5aac5ba805825da76410c181273ba90b1":
    parser.error("use the workflow-pinned actions/checkout dist/index.js")
source = Path.cwd().resolve()
owner = source / ".github/actions/git-owner/owner.py"


def git(cwd, *arguments):
    return subprocess.check_output(["git", "-C", str(cwd), *arguments], stderr=subprocess.PIPE)


revision = git(source, "rev-parse", "HEAD").decode().strip()
rows = []
with tempfile.TemporaryDirectory(prefix="security-harness-measure-") as scratch:
    root = Path(scratch)
    workspace = root / "candidate"
    git(source, "clone", "--quiet", "--shared", "--no-checkout", str(source), str(workspace))
    git(workspace, "checkout", "--quiet", "--detach", revision)
    expected = []
    for entry in git(workspace, "ls-tree", "-rz", revision, "--", *paths).split(b"\0"):
        if entry:
            metadata, name = entry.split(b"\t", 1)
            filename = os.fsdecode(name)
            expected.append((filename, metadata.split()[0], git(workspace, "show", f"{revision}:{filename}")))
    for sample in range(-1, args.samples):  # One excluded warm-up per arm; then ABAB.
        for variant in ("checkout-action", "index-export"):
            harness = workspace / ".ci-harness"
            if harness.exists():
                shutil.rmtree(harness)
            with tempfile.TemporaryDirectory(dir=root) as run:
                run = Path(run)
                for name in ("output", "state"):
                    (run / name).touch()
                config = run / "gitconfig"
                config.write_text(f'[url "{source.as_uri()}"]\n\tinsteadOf = https://github.com/fixture/harness\n'
                                  '[uploadpack]\n\tallowFilter = true\n')
                # No operator configuration, credential or external Git transport enters this fixture.
                env = {"PATH": os.environ["PATH"], "HOME": str(run), "LANG": "C.UTF-8",
                       "GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1",
                       "GIT_CONFIG_COUNT": "0", "GIT_ALLOW_PROTOCOL": "file",
                       "GIT_TRACE2_EVENT": str(run / "git-trace"),
                       "GITHUB_WORKSPACE": str(workspace), "GITHUB_REPOSITORY": "fixture/harness",
                       "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": revision,
                       "GITHUB_OUTPUT": str(run / "output"), "GITHUB_STATE": str(run / "state"),
                       "RUNNER_TEMP": str(run), "RUNNER_OS": "Linux", "GITHUB_ACTIONS": "true",
                       "INPUT_REPOSITORY": "fixture/harness", "INPUT_REF": revision,
                       "INPUT_TOKEN": "synthetic-local-origin", "INPUT_PATH": ".ci-harness",
                       "INPUT_FETCH-DEPTH": "1", "INPUT_PERSIST-CREDENTIALS": "false",
                       "INPUT_CLEAN": "true", "INPUT_FETCH-TAGS": "false",
                       "INPUT_SHOW-PROGRESS": "true", "INPUT_LFS": "false",
                       "INPUT_SUBMODULES": "false", "INPUT_SET-SAFE-DIRECTORY": "true",
                       "INPUT_SSH-STRICT": "true", "INPUT_SSH-USER": "git",
                       "INPUT_SPARSE-CHECKOUT-CONE-MODE": "true",
                       "INPUT_ALLOW-UNSAFE-PR-CHECKOUT": "false",
                       "INPUT_SPARSE-CHECKOUT": "\n".join(paths),
                       "CHECKOUT_KIND": "security-harness", "WORKFLOW_SHA": revision}
                command = ([args.action_node, str(action)] if variant == "checkout-action"
                           else [sys.executable, "-I", "-S", str(owner)])
                load = os.getloadavg()
                result = subprocess.run(["/usr/bin/time", "-f", "%e %U %S %M", "-o", str(run / "time"),
                                         *command], cwd=workspace, env=env, capture_output=True)
                if result.returncode:
                    raise RuntimeError(f"{variant} failed: {result.stderr.decode(errors='replace')[-2000:]}")
                seconds, user, system, rss = map(float, (run / "time").read_text().split())
                trace = [json.loads(line) for line in (run / "git-trace").read_text().splitlines()]
                fetches = sum(event.get("event") == "start" and "fetch" in event.get("argv", [])
                              for event in trace)
                for name, mode, contents in expected:
                    file = harness / name
                    actual = os.fsencode(os.readlink(file)) if file.is_symlink() else file.read_bytes()
                    actual_mode = (b"120000" if file.is_symlink() else
                                   b"100755" if file.stat().st_mode & 0o111 else b"100644")
                    if actual != contents or actual_mode != mode:
                        raise RuntimeError(f"harness bytes or executable mode differ: {name}")
                if (variant == "index-export" and fetches) or (variant == "checkout-action" and not fetches):
                    raise RuntimeError("unexpected fetch count")
                row = dict(sample=sample, variant=variant, seconds=seconds, cpu=user + system,
                           peakRssKiB=rss, fetches=fetches, files=len(expected), load=load)
                if sample >= 0:
                    rows.append(row)
                print(json.dumps(row), flush=True)
result = dict(scope="warm filesystem; fresh harness; local origin; no WAN or runner scheduling",
              revision=revision, ownerSha256=hashlib.sha256(owner.read_bytes()).hexdigest(),
              node=subprocess.check_output([args.action_node, "--version"]).decode().strip(),
              cpus=os.cpu_count(), affinity=sorted(os.sched_getaffinity(0)),
              hostRamBytes=os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
              cgroups={name: Path(f"/sys/fs/cgroup/{name}").read_text().strip()
                       if Path(f"/sys/fs/cgroup/{name}").exists() else None
                       for name in ("cpu.max", "memory.max")}, rows=rows)
args.output.write_text(json.dumps(result, indent=2) + "\n")
