#!/usr/bin/env python3
"""Actions-only AOT artifact admission, archive validation, and measurements."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import resource
import signal
import shutil
import subprocess
import sys
import tarfile
import time

BUN = "fd40ba44187c721ee023062fa153a6a27560e6b1"
WEBKIT = "aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8"
COMPILER_SHA256 = "d9e1bbfd8e298c8d51bd1c5fe7a106827119355bff2b88528aa69cf823202c95"
GIB = 1024**3
EXPECTED_MIN_OS = "27.0"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(file):
    result = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(file, value):
    Path(file).write_text(json.dumps(value, indent=2) + "\n")


def macho_build_version(executable):
    output = subprocess.check_output(["/usr/bin/vtool", "-show-build", str(executable)], text=True)
    minimums = re.findall(r"^\s*minos\s+([0-9.]+)\s*$", output, re.MULTILINE)
    sdks = re.findall(r"^\s*sdk\s+([0-9.]+)\s*$", output, re.MULTILINE)
    platforms = re.findall(r"^\s*platform\s+(\S+)\s*$", output, re.MULTILINE)
    require(len(minimums) == len(sdks) == 1 and platforms == ["MACOS"],
        "Expected one native macOS LC_BUILD_VERSION")
    return {"minimumOperatingSystem": minimums[0], "sdk": sdks[0]}


def admit(root):
    require(sys.platform == "darwin" and platform.machine() == "arm64", "Native macOS arm64 host required")
    require(int(platform.mac_ver()[0].split(".")[0]) >= 27, "This compiler requires a macOS 27 or newer runner")
    memory = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]))
    minimum = int(os.environ["MIN_MEMORY_GIB"]) * GIB
    disks = {str(path): shutil.disk_usage(path).free for path in (Path("/"), root)}
    pressure = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True)
    host = {
        "platform": platform.platform(), "machine": platform.machine(),
        "physicalMemoryBytes": memory, "minimumMemoryBytes": minimum,
        "diskFreeBytes": disks, "memoryPressureReport": pressure.stdout,
        "memoryPressureExitCode": pressure.returncode,
        "xcode": subprocess.check_output(["xcodebuild", "-version"], text=True),
    }
    with (root / "evidence/host-admissions.jsonl").open("a") as output:
        output.write(json.dumps(host) + "\n")
    require(memory >= minimum, "Physical RAM is below the operator-selected build admission threshold")
    require(all(free >= 25 * GIB for free in disks.values()), "Internal and output volumes each require at least 25 GiB free")
    # Pressure output is an observation, not a claim of exact free memory.
    print(f"Admitted {memory / GIB:.1f} GiB physical RAM; {disks}")


def provenance(root):
    artifact = json.loads((root / "evidence/toolchain-artifact.json").read_text())
    run = json.loads((root / "evidence/toolchain-run.json").read_text())
    require(artifact["id"] == int(os.environ["TOOLCHAIN_ARTIFACT_ID"]), "Artifact ID mismatch")
    require(not artifact["expired"], "Toolchain artifact expired")
    require(artifact["workflow_run"]["id"] == int(os.environ["TOOLCHAIN_RUN_ID"]), "Artifact/run mismatch")
    require(run["id"] == int(os.environ["TOOLCHAIN_RUN_ID"]), "Run ID mismatch")
    require(run["repository"]["full_name"] == os.environ["GITHUB_REPOSITORY"], "Toolchain must come from this repository")
    require(run["head_repository"]["full_name"] == os.environ["GITHUB_REPOSITORY"], "Fork toolchain producer rejected")
    require(run["head_branch"] == "main" and run["conclusion"] == "success", "Successful main producer run required")
    require(run["event"] in ("push", "workflow_dispatch"), "Toolchain producer must be a push or manual run")


def unpack_bundle(archive, destination):
    """Copy regular members only; never follow an archive-provided link."""
    require(not destination.exists(), "Toolchain destination must be fresh")
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        names = set()
        total = 0
        for item in members:
            name = PurePosixPath(item.name)
            require(not name.is_absolute() and ".." not in name.parts and "\\" not in item.name, "Unsafe toolchain member path")
            require(name.parts and name.parts[0] == "toolchain", "Expected one toolchain/ root")
            require(item.isfile() or item.isdir(), "Toolchain links and special files are not allowed")
            normalized = str(name)
            require(normalized not in names, "Duplicate toolchain member")
            names.add(normalized)
            total += item.size
        require(total <= 5 * GIB, "Expanded toolchain exceeds 5 GiB")
        destination.mkdir()
        for item in members:
            relative = PurePosixPath(item.name).parts[1:]
            target = destination.joinpath(*relative)
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(item) as incoming, target.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                target.chmod(0o755 if item.mode & 0o111 else 0o644)


def extract(root):
    bundle = root / "download/toolchain.tar.gz"
    require(digest(bundle) == os.environ["TOOLCHAIN_BUNDLE_SHA256"], "Toolchain bundle SHA256 mismatch")
    target = root / "toolchain"
    unpack_bundle(bundle, target)
    manifest = json.loads((target / "manifest.json").read_text())
    require(manifest == {
        "schemaVersion": 1, "bunCommit": BUN, "webkitCommit": WEBKIT,
        "profile": "standard", "platform": "darwin", "arch": "arm64",
        "executable": "bin/bun", "executableSha256": COMPILER_SHA256,
    }, "Unexpected compiler bundle manifest")
    require(digest(target / "bin/bun") == COMPILER_SHA256, "Qualified compiler SHA256 mismatch")
    build_version = macho_build_version(target / "bin/bun")
    write_json(root / "evidence/compiler.json", {**manifest, "machOBuildVersion": build_version,
        "bundleSha256": os.environ["TOOLCHAIN_BUNDLE_SHA256"]})
    require(build_version["minimumOperatingSystem"] == EXPECTED_MIN_OS,
        "Compiler minimum macOS version differs from the pinned macOS 27 experiment")
    revision = subprocess.check_output([str(target / "bin/bun"), "--revision"], text=True).strip()
    write_json(root / "evidence/compiler.json", {**manifest, "revision": revision,
        "machOBuildVersion": build_version, "bundleSha256": os.environ["TOOLCHAIN_BUNDLE_SHA256"]})


def tree_rss(pid):
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss="], text=True)
    processes = [tuple(map(int, row.split())) for row in rows.splitlines() if row.strip()]
    descendants = {pid}
    while True:
        expanded = descendants | {child for child, parent, _ in processes if parent in descendants}
        if expanded == descendants:
            return sum(rss * 1024 for child, _, rss in processes if child in descendants)
        descendants = expanded


def measure(root, phase, command):
    require(re.fullmatch(r"[a-z]+", phase), "Invalid measurement phase")
    require(command, "Expected command")
    started = time.monotonic()
    peak = 0
    process = None
    failure = None
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    previous_handler = signal.getsignal(signal.SIGTERM)

    def terminate(_signal, _frame):
        raise InterruptedError("Measurement received SIGTERM")

    signal.signal(signal.SIGTERM, terminate)
    try:
        with (root / f"evidence/{phase}.log").open("w") as log:
            try:
                process = subprocess.Popen(
                    ["nice", "-n", "10", "/usr/bin/time", "-l", *command],
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                )
                while process.poll() is None:
                    peak = max(peak, tree_rss(process.pid))
                    time.sleep(1)
                require(process.returncode == 0, f"{phase} exited {process.returncode}")
            except BaseException as error:
                failure = f"{type(error).__name__}: {error}"
                log.write(f"\nMeasurement failure: {failure}\n")
                raise
            finally:
                # SIGTERM must run cleanup; SIGKILL and host loss cannot do so.
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                if process is not None and (failure or process.poll() is None):
                    for action in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(process.pid, action)
                        except ProcessLookupError:
                            break
                        if action == signal.SIGTERM:
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                pass
                    process.wait()
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        write_json(root / f"evidence/{phase}.json", {
            "command": command, "exitCode": process.returncode if process else None,
            "failure": failure, "wallSeconds": time.monotonic() - started,
            "supervisorChildUserSeconds": after.ru_utime - before.ru_utime,
            "supervisorChildSystemSeconds": after.ru_stime - before.ru_stime,
            "sampledPeakTreeRssBytes": peak, "rssSampleIntervalSeconds": 1,
            "measurementLimit": "Tree RSS is a 1-second sampled lower bound; supervisor child CPU includes ps sampling. Darwin time -l in the log records measured command CPU and maximum RSS.",
        })


def verify_output(root):
    output = root / "output"
    manifest = json.loads((output / "manifest.json").read_text())
    require(manifest["mode"] == "aot", "Expected AOT output, not a JIT fallback")
    require(manifest["target"] == {"platform": "darwin", "arch": "arm64"}, "Output target mismatch")
    require(manifest["openclaw"]["commit"] == os.environ["SOURCE_SHA"], "Output source mismatch")
    require(manifest["macos"]["entitlements"] == {"com.apple.security.cs.disable-library-validation": True}, "Unexpected AOT signing policy")
    require(manifest["executable"]["path"] == "openclaw", "Unexpected output executable")
    require(digest(output / "openclaw") == manifest["executable"]["sha256"], "Output executable hash mismatch")
    build_version = macho_build_version(output / "openclaw")
    write_json(root / "evidence/output-mach-o.json", build_version)
    require(build_version["minimumOperatingSystem"] == EXPECTED_MIN_OS,
        "Output minimum macOS version differs from the macOS 27-only artifact label")
    subprocess.run(["node", "--input-type=module", "-e", """
import fs from 'node:fs';
import path from 'node:path';
import { describeStandaloneRuntime } from './scripts/lib/bun-standalone-contract.mjs';
const root = process.argv[1];
const expected = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).runtime;
const actual = await describeStandaloneRuntime(path.join(root, 'runtime'));
for (const key of ['path', 'sizeBytes', 'sha256', 'fileCount', 'symlinkCount']) {
  if (actual[key] !== expected[key]) throw new Error('Runtime manifest mismatch: ' + key);
}
""", str(output)], check=True)
    home = root / "smoke-home"
    home.mkdir()
    environment = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": str(root / "tmp"), "OPENCLAW_STATE_DIR": str(home / "state"),
        "OPENCLAW_CONFIG_PATH": str(home / "config.json"), "OPENCLAW_NO_RESPAWN": "1"}
    with (root / "evidence/smoke.log").open("w") as log:
        for option in ("--version", "--help"):
            subprocess.run([str(output / "openclaw"), option], env=environment,
                cwd=home, timeout=120, check=True, stdout=log, stderr=subprocess.STDOUT)
    descriptor = {
        "sourceSha": os.environ["SOURCE_SHA"], "buildTimestamp": os.environ["OPENCLAW_BUILD_TIMESTAMP"],
        "requestedDeploymentTarget": os.environ["OPENCLAW_MACOS_DEPLOYMENT_TARGET"],
        "machOBuildVersion": build_version, "compatibility": "macOS 27-only experiment; macOS 15 unsupported",
        "bunCommit": BUN, "webkitCommit": WEBKIT,
        "compilerSha256": COMPILER_SHA256, "profile": "emitted-js-standard",
        "signed": False, "notarized": False, "smoke": ["--version", "--help"],
        "qualification": "Experimental; not full runtime or distribution qualification",
    }
    write_json(output / "experimental-artifact.json", descriptor)
    archive = root / "openclaw-aot-js-darwin-arm64-macos27-only.tar.gz"
    with tarfile.open(archive, "w:gz") as package:
        package.add(output, arcname="openclaw-aot-js-darwin-arm64-macos27-only")
    write_json(root / "evidence/output.json", {**descriptor, "archiveSha256": digest(archive),
        "archiveBytes": archive.stat().st_size, "executableSha256": manifest["executable"]["sha256"]})


def main():
    root = Path(os.environ["AOT_ROOT"])
    operation = sys.argv[1]
    if operation == "measure":
        require(sys.argv[3] == "--", "Expected -- before measured command")
        measure(root, sys.argv[2], sys.argv[4:])
    else:
        {"admit": admit, "provenance": provenance, "extract": extract,
            "verify-output": verify_output}[operation](root)


if __name__ == "__main__":
    main()
