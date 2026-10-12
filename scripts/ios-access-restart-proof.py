#!/usr/bin/env python3
"""Verify acknowledged Access sign-out across two processes on one installed app."""

import copy
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(arguments, capture=False, env=None, timeout=None):
    return subprocess.run(
        arguments, check=True, text=True, stdout=subprocess.PIPE if capture else None,
        env=env, timeout=timeout,
    ).stdout


def read_plist(path):
    with path.open("rb") as handle:
        return plistlib.load(handle)


def bundle_identity(bundle):
    info = read_plist(bundle / "Info.plist")
    executable = bundle / info["CFBundleExecutable"]
    require(executable.parent == bundle, "Unexpected bundle executable path")
    return info["CFBundleIdentifier"], hashlib.sha256(executable.read_bytes()).hexdigest()


def selected_target(document):
    if document.get("__xctestrun_metadata__", {}).get("FormatVersion", 1) == 1:
        return document["OpenClawTests"]
    return document["TestConfigurations"][0]["TestTargets"][0]


def selected_run(products):
    candidates = []
    for path in products.glob("OpenClaw_*.xctestrun"):
        document = read_plist(path)
        version = document.get("__xctestrun_metadata__", {}).get("FormatVersion", 1)
        require(version in (1, 2), "Unsupported generated test run format")
        # Schemes without a test plan still generate v1's top-level target dictionaries.
        if version == 1:
            if isinstance(document.get("OpenClawTests"), dict):
                candidates.append({
                    key: copy.deepcopy(value) for key, value in document.items()
                    if key == "OpenClawTests" or key.startswith("__")
                })
            continue
        for configuration in document.get("TestConfigurations", []):
            if not configuration.get("IsEnabled", True):
                continue
            for target in configuration.get("TestTargets", []):
                if target.get("BlueprintName") == "OpenClawTests":
                    selected = copy.deepcopy(document)
                    selected_configuration = copy.deepcopy(configuration)
                    selected_configuration["TestTargets"] = [copy.deepcopy(target)]
                    selected["TestConfigurations"] = [selected_configuration]
                    candidates.append(selected)
    require(len(candidates) == 1, "Expected one generated OpenClawTests run configuration")
    selected = candidates[0]
    target = selected_target(selected)
    require(isinstance(target.get("TestingEnvironmentVariables"), dict), "Missing test host environment")
    for key in ["OnlyTestIdentifiers", "SkipTestIdentifiers"]:
        target.pop(key, None)
    return selected


def verify_result(result, simulator):
    prefix = ["xcrun", "xcresulttool", "get", "test-results"]
    summary = json.loads(run(prefix + ["summary", "--path", str(result)], capture=True))
    require(
        summary.get("result") == "Passed" and summary.get("totalTestCount", 0) > 0
        and summary.get("passedTests") == summary.get("totalTestCount")
        and summary.get("failedTests") == 0 and summary.get("skippedTests") == 0
        and summary.get("expectedFailures") == 0 and summary.get("testFailures") == [],
        "Restart repetitions must pass with no failures or skips",
    )
    tree = json.loads(run(prefix + ["tests", "--path", str(result)], capture=True))

    def nodes(value):
        if isinstance(value, dict):
            yield value
            for child in value.get("children", []):
                yield from nodes(child)
        elif isinstance(value, list):
            for child in value:
                yield from nodes(child)

    bundles = [node for node in nodes(tree.get("testNodes", [])) if node.get("nodeType") == "Unit test bundle"]
    require(len(bundles) == 1 and bundles[0].get("name") == "OpenClawTests", "Wrong restart test bundle")
    cases = [node for node in nodes(tree.get("testNodes", [])) if node.get("nodeType") == "Test Case"]
    require(len(cases) == 1 and cases[0] in list(nodes(bundles[0])), "Missing or duplicate restart test case")
    identifier = "GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart()"
    require(cases[0].get("nodeIdentifier") == identifier and cases[0].get("result") == "Passed",
            "Wrong restart test executed")
    details = json.loads(run(prefix + ["test-details", "--path", str(result), "--test-id", identifier], capture=True))
    require(details.get("testIdentifier") == identifier and details.get("testResult") == "Passed"
            and not details.get("arguments"), "Wrong restart test details")
    summary_runs = summary.get("devicesAndConfigurations", [])
    require(len(summary_runs) == 1 and summary_runs[0].get("device", {}).get("deviceId") == simulator,
            "Restart summary used an unexpected device or configuration")
    configuration = summary_runs[0].get("testPlanConfiguration", {}).get("configurationId")
    require(isinstance(configuration, str) and configuration, "Missing restart configuration")
    for document in [tree, details]:
        devices, configurations = document.get("devices", []), document.get("testPlanConfigurations", [])
        require(len(devices) == 1 and devices[0].get("deviceId") == simulator,
                "Restart repetitions used an unexpected device")
        require(len(configurations) == 1 and configurations[0].get("configurationId") == configuration,
                "Restart repetitions used an unexpected configuration")

    def repetition_ids(repetitions):
        # xcresult reports case counts separately; the selected case owns two direct execution records.
        require(len(repetitions) == 2 and all(node.get("nodeType") == "Repetition"
                and node.get("result") == "Passed" and not node.get("children")
                and isinstance(node.get("nodeIdentifier"), str) and node["nodeIdentifier"]
                and node.get("name") for node in repetitions),
                "Expected two passing leaf restart repetitions; unsupported or incomplete result shape")
        identifiers = {node["nodeIdentifier"] for node in repetitions}
        require(len(identifiers) == 2 and len({node["name"] for node in repetitions}) == 2,
                "Duplicate restart repetition")
        return identifiers

    require(repetition_ids(details.get("testRuns", [])) == repetition_ids(cases[0].get("children", [])),
            "Restart repetition identities differ between result records")


def file_identity(path):
    path = path.resolve(strict=True)
    metadata = path.stat()
    return {"path": str(path), "device": metadata.st_dev, "inode": metadata.st_ino}


def installation_identity(app, tests, data):
    app_id, app_digest = bundle_identity(app)
    test_id, test_digest = bundle_identity(tests)
    return {
        "bundleID": app_id, "testBundleID": test_id,
        "app": file_identity(app), "testBundle": file_identity(tests),
        "executable": file_identity(app / read_plist(app / "Info.plist")["CFBundleExecutable"]),
        "testExecutable": file_identity(tests / read_plist(tests / "Info.plist")["CFBundleExecutable"]),
        "container": file_identity(data), "executableSHA256": app_digest, "testExecutableSHA256": test_digest,
    }


def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main(simulator):
    source = run(["git", "rev-parse", "HEAD"], capture=True).strip()
    require(len(source) == 40 and all(c in "0123456789abcdef" for c in source), "Missing source identity")
    nonce = str(uuid.uuid4())
    destination = f"platform=iOS Simulator,id={simulator}"
    build = ["xcodebuild", "-project", "apps/ios/OpenClaw.xcodeproj", "-scheme", "OpenClaw",
             "-configuration", "Debug", "-destination", destination]
    # Reuse the preceding lifecycle build products; the generated plist owns host paths and environment.
    run(build + ["-parallel-testing-enabled", "NO", "build-for-testing"])
    settings = json.loads(run(build + ["-showBuildSettings", "-json"], capture=True))
    hosts = [row["buildSettings"] for row in settings if row.get("target") == "OpenClaw"]
    require(len(hosts) == 1, "Expected one OpenClaw build target")
    products = Path(hosts[0]["BUILD_DIR"])
    built_app = Path(hosts[0]["TARGET_BUILD_DIR"]) / hosts[0]["FULL_PRODUCT_NAME"]
    require(products.is_absolute() and built_app.is_absolute(), "Build products must be absolute")
    bundle_id, built_digest = bundle_identity(built_app)
    document = selected_run(products)
    results = Path("apps/ios/build/LifecycleTestResults")
    results.mkdir(parents=True, exist_ok=True)

    # Keep __TESTROOT__ and the generated host/bundle paths unchanged. Simulator repetition
    # relaunches the test process; the nonce receipt independently proves artifact and state continuity.
    run_file = products / "OpenClawAccessRestart.xctestrun"
    with run_file.open("wb") as handle:
        plistlib.dump(document, handle)
    result = results / "AccessRestart.xcresult"
    environment = dict(os.environ)
    for key, value in {"NONCE": nonce, "SOURCE": source, "DEVICE": simulator}.items():
        environment[f"TEST_RUNNER_OPENCLAW_ACCESS_RESTART_{key}"] = value
    run(["xcodebuild", "-xctestrun", str(run_file), "-destination", destination,
         "-parallel-testing-enabled", "NO", "-test-iterations", "2", "-test-repetition-relaunch-enabled", "YES",
         "-only-testing:OpenClawTests/GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart", "-resultBundlePath", str(result),
         "test-without-building"], env=environment)
    verify_result(result, simulator)
    # Xcode may shut down this destination after testing; container inspection needs it booted.
    run(["xcrun", "simctl", "bootstatus", simulator, "-b"], timeout=120)

    def container(kind):
        return Path(run(["xcrun", "simctl", "get_app_container", simulator, bundle_id, kind], capture=True).strip()).resolve(strict=True)

    app, data = container("app"), container("data")
    require(bundle_identity(app) == (bundle_id, built_digest), "Installed app differs from the build")
    test_bundles = list((app / "PlugIns").glob("OpenClawTests.xctest"))
    require(len(test_bundles) == 1, "Expected one installed hosted test bundle")
    receipt_file = data / "Library/Application Support" / f"access-restart-{nonce}.plist"
    receipt = read_plist(receipt_file)
    require(receipt["phase"] == "verified" and receipt["seedProcessExited"] is True,
            "Missing completed restart handoff")
    require(receipt["nonce"] == nonce and receipt["source"] == source and receipt["simulator"] == simulator,
            "Restart handoff identity mismatch")
    require(receipt["installation"] == installation_identity(app, test_bundles[0], data),
            "Installed artifacts or storage changed across restart")
    seed_pid, verify_pid = receipt["seedPID"], receipt["verifyPID"]
    require(type(seed_pid) is int and type(verify_pid) is int and min(seed_pid, verify_pid) > 1
            and seed_pid != verify_pid, "Missing distinct restart process identities")
    require(not process_exists(seed_pid), "Seed app process did not exit")
    require(isinstance(receipt["expiresAt"], datetime)
            and receipt["expiresAt"] > datetime.now(timezone.utc).replace(tzinfo=None),
            "Retained control session expired")
    receipt_file.unlink()
    print(f"ACCESS_RESTART passed source={source} seed_pid={seed_pid} verify_pid={verify_pid} "
          f"app_sha256={built_digest} test_sha256={receipt['installation']['testExecutableSHA256']}")


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and bool(sys.argv[1]), "Expected simulator UDID")
        main(sys.argv[1])
    except Exception as error:
        print(str(error), file=sys.stderr)
        print("[ios-access-restart] FAILED (exit 1)", file=sys.stderr)
        sys.exit(1)
