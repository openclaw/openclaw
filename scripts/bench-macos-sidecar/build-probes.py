#!/usr/bin/env python3
"""Build isolated probes from immutable baseline and a selected candidate checkout."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


MODULES = ["OpenClawKit", "OpenClawProtocol", "OpenClawNativeState"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(repo, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=repo)


def ensure_clean_repo(repo):
    status = git(repo, "status", "--porcelain", "--untracked-files=all").decode().strip()
    if status:
        raise ValueError("Candidate checkout must be clean before recording exact-head probe evidence")


def build_helper(repo, root):
    target_dir = root / "cargo-target"
    command = [
        "cargo",
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        str(repo / "crates/Cargo.toml"),
        "--target-dir",
        str(target_dir),
        "-p",
        "openclaw-mac-node-sidecar",
    ]
    subprocess.run(command, check=True)
    helper = target_dir / "release/openclaw-mac-node-sidecar"
    if not helper.is_file():
        raise FileNotFoundError("Cargo did not produce the macOS sidecar helper")
    shutil.copy2(helper, root / "bin/openclaw-mac-node-sidecar")
    return command


def copy_from_ref(repo, ref, paths, destination, prefix="."):
    names = git(repo, "ls-tree", "-r", "--name-only", ref, "--", *paths)
    for name in names.decode().splitlines():
        target = destination / Path(name).relative_to(prefix)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(repo, "show", ref + ":" + name))


def prepare_protocol(repo, root, sources, ref, variant):
    models = sources / "OpenClawProtocol/GatewayModels.swift"
    # Historical comparisons retain their checked-in protocol; newer revisions
    # must run their own generator so baseline schemas never come from HEAD.
    if models.is_file():
        return {"sourceCommit": ref, "owner": "tracked", "outputSHA256": digest(models)}
    manifest_path = "scripts/native-protocol-inputs.json"
    manifest = json.loads(git(repo, "show", ref + ":" + manifest_path))
    source = root / (variant + "-protocol-source")
    copy_from_ref(repo, ref, manifest["directories"] + manifest["files"], source)
    inputs = {
        str(path.relative_to(source)): digest(path)
        for path in sorted(source.rglob("*")) if path.is_file()
    }
    # Reuse the frozen checkout's dependencies, as the canonical generator's
    # own source-fixture test does; generated inputs remain variant-specific.
    (source / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    output = root / (variant + "-protocol-generated")
    command = [
        "node", str(source / "scripts/prepare-native-protocol.mjs"),
        "--language", "swift", "--out", str(output),
    ]
    subprocess.run(command, cwd=source, check=True)
    shutil.copy2(output / "GatewayModels.swift", models)
    return {
        "sourceCommit": ref,
        "owner": "prepare-native-protocol",
        "inputs": inputs,
        "command": command,
        "dependencyRoot": str(repo / "node_modules"),
        "outputSHA256": digest(models),
    }


def build_variant(repo, root, scripts, base, variant, protocol):
    package = root / (variant + "-build")
    sources = package / "Sources"
    sources.mkdir(parents=True)
    ref = base if variant == "baseline" else git(repo, "rev-parse", "HEAD").decode().strip()
    prefix = "apps/shared/OpenClawKit/Sources"
    copy_from_ref(repo, ref, [prefix + "/" + module for module in MODULES], sources, prefix)
    protocol[variant] = prepare_protocol(repo, root, sources, ref, variant)

    targets = [
        '.target(name:"OpenClawProtocol")',
        '.target(name:"OpenClawNativeState")',
        '.target(name:"OpenClawKit",dependencies:["OpenClawProtocol","OpenClawNativeState"],'
        'resources:[.process("Resources")])',
    ]
    if variant == "baseline":
        products = [
            ("Bench", "Baseline.swift", "baseline-swift"),
            ("AuxiliaryProbe", "Auxiliary.swift", "auxiliary-baseline"),
        ]
    else:
        products = [
            ("Bench", "Candidate.swift", "candidate-swift"),
            ("FunctionalProbe", "Functional.swift", "functional-probe"),
            ("AuxiliaryProbe", "Auxiliary.swift", "auxiliary-probe"),
            ("TLSProbe", "TLS.swift", "tls-probe"),
            ("BackpressureProbe", "Backpressure.swift", "backpressure-probe"),
            ("FramingProbe", "Framing.swift", "framing-probe"),
            ("StartupProbe", "Startup.swift", "startup-probe"),
            ("FramingHelper", "FramingHelper.swift", "framing-helper"),
        ]
        shutil.copytree(
            repo / "apps/macos/Sources/OpenClawRustSidecar",
            sources / "OpenClawRustSidecar",
        )
        targets.append('.target(name:"OpenClawRustSidecar",dependencies:["OpenClawKit"])')

    for target, source, _ in products:
        destination = sources / target
        destination.mkdir()
        shutil.copy2(scripts / "Probes" / source, destination / "main.swift")
        dependencies = ["OpenClawKit", "OpenClawProtocol"]
        if variant == "candidate":
            dependencies.append("OpenClawRustSidecar")
        targets.append(
            f'.executableTarget(name:"{target}",dependencies:{json.dumps(dependencies)})'
        )
    (package / "Package.swift").write_text(
        "// swift-tools-version: 6.3\nimport PackageDescription\n"
        'let package=Package(name:"RFC54Probe",platforms:[.macOS(.v15)],targets:['
        + ",".join(targets)
        + "])\n"
    )
    for target, _, binary in products:
        subprocess.run(
            ["swift", "build", "-c", "release", "--package-path", str(package), "--product", target],
            check=True,
        )
        shutil.copy2(package / ".build/release" / target, root / "bin" / binary)
        if target == "FramingHelper":
            for scenario in [
                "idle-after-control", "within-budget", "partial-prefix", "combined-budget",
                "writer-overflow",
                "startup-delayed", "startup-claimed", "startup-cancelled", "startup-exit", "startup-stalled", "startup-discarded", "startup-reconnect",
            ]:
                (root / "bin" / (binary + "-" + scenario)).symlink_to(binary)
    return {
        str(path.relative_to(sources)): digest(path)
        for path in sorted(sources.rglob("*"))
        if path.is_file()
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base", default="HEAD")
    args = parser.parse_args()
    repo = args.repo.resolve()
    root = args.output.resolve()
    scripts = Path(__file__).resolve().parent
    if root.parent != Path("/tmp").resolve():
        parser.error("Use a fresh output directory directly under /tmp for this sandbox profile")
    # A fresh tree prevents deleted candidate sources from surviving a repeated build.
    if args.output.is_symlink() or root.exists():
        parser.error("Output already exists; choose a new directory to preserve source provenance")
    root.mkdir()
    for name in ["bin", "home", "tmp", "tls-fixtures"]:
        (root / name).mkdir()
    shutil.copy2(scripts / "sandbox.sb", root / "sandbox.sb")
    ensure_clean_repo(repo)
    args.base = git(
        repo, "rev-parse", "--verify", "--end-of-options", args.base + "^{commit}"
    ).decode().strip()
    helper_command = build_helper(repo, root)
    metadata = {
        "baseline": args.base,
        "candidateHead": git(repo, "rev-parse", "HEAD").decode().strip(),
        "helperBuildCommand": helper_command,
        "swift": subprocess.check_output(["swift", "--version"], text=True).strip(),
        "machine": subprocess.check_output(
            ["sysctl", "-n", "hw.model", "hw.ncpu", "hw.memsize"], text=True
        ).strip(),
        "os": subprocess.check_output(["sw_vers"], text=True).strip(),
        "sources": {},
        "protocol": {},
    }
    for variant in ["baseline", "candidate"]:
        metadata["sources"][variant] = build_variant(
            repo, root, scripts, args.base, variant, metadata["protocol"]
        )
    source = (repo / "crates/openclaw-gateway-client/tests/tls_policy.rs").read_text()
    for name, destination in [("CERTIFICATE", "localhost.der"), ("KEY", "localhost-key.der")]:
        match = re.search(r"const " + name + r": &\[u8\] = &\[(.*?)\];", source, re.S)
        if match is None:
            raise ValueError("Missing synthetic TLS fixture constant: " + name)
        octets = re.findall(r"0x([0-9a-fA-F]{2})", match.group(1))
        (root / "tls-fixtures" / destination).write_bytes(bytes(int(x, 16) for x in octets))
    subprocess.run(
        ["clang", str(scripts / "sandbox-probe.c"), "-o", str(root / "bin/sandbox-probe")],
        check=True,
    )
    metadata["binaries"] = {path.name: digest(path) for path in sorted((root / "bin").iterdir())}
    metadata["trackedDiffSHA256"] = hashlib.sha256(git(repo, "diff", args.base)).hexdigest()
    (root / "build-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Build complete. Set RFC54_BENCH_ROOT to the output and OPENCLAW_BENCH_REPO to the checkout.")


if __name__ == "__main__":
    main()
