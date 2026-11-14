"""Source/data-only selected-test collector; never imports or executes product code."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
BASE = "5fed4f0df99d1d1c3e7a9ac8b9848aac6526af29"
TRIGGERS = ("download", "stop", "replacement")
NAMES = (
    "a failed first load explains the failure and Reload retries the attempted URL",
    "a failed navigation covers the loaded page and toolbar Reload retries the failed URL",
    "deliberate interruptions keep the page without failure UI",
)
PHASES = ("select", "xcode", "swift", "os", "developer", "node", "pnpm", "dependencies", "assets", "build", "native")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    assert path.stat().st_size <= 262144
    return json.loads(path.read_text())


def save(path, value):
    data = json.dumps(value, indent=2, sort_keys=True) + "\n"
    assert len(data) <= 262144
    path.write_text(data)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL, timeout=20).decode().strip()


def source(root, harness, initial=False):
    manifest = load(HERE / "manifest.json")
    sha = os.environ["CANDIDATE_SHA"]
    workflow = os.environ["WORKFLOW_SHA"]
    assert re.fullmatch("[0-9a-f]{40}", sha) and sha != BASE
    assert re.fullmatch("[0-9a-f]{40}", workflow) and workflow == os.environ["EXPECTED_WORKFLOW_SHA"]
    assert git(root, "rev-parse", "HEAD") == sha
    assert git(root, "rev-list", "--parents", "-n", "1", "HEAD") == sha + " " + BASE
    assert git(harness, "rev-parse", "HEAD") == BASE
    assert git(HERE, "rev-parse", "HEAD") == workflow
    assert not git(root, "status", "--porcelain", "--untracked-files=all" if initial else "--untracked-files=no", "--", ".", ":(exclude)proof", ":(exclude)harness")
    assert not git(harness, "status", "--porcelain")
    assert not git(HERE, "status", "--porcelain")
    assert set(git(root, "diff", "--name-only", BASE, "HEAD").splitlines()) == set(manifest["changed"])
    for name, expected in manifest["sources"].items():
        assert digest((harness / name).read_bytes()) == expected
        assert digest((root / name).read_bytes()) == manifest["changed"].get(name, expected)
    return {"base": BASE, "candidate": sha, "tree": git(root, "rev-parse", "HEAD^{tree}"), "workflow": workflow,
            "run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "manifestSha256": digest((HERE / "manifest.json").read_bytes()), "scope": "selected-native-tests"}


def extract(path):
    # Stream bounded raw evidence. No line contents are returned except allowlisted facts.
    assert path.stat().st_size <= 32 * 1024 * 1024
    starts = [0, 0, 0]
    ends = [0, 0, 0]
    args = {t: 0 for t in TRIGGERS}
    suite_start = suite_end = 0
    terminal = []
    with path.open(encoding="utf-8", errors="strict") as stream:
        for raw in stream:
            assert len(raw) <= 16384
            line = raw.rstrip("\r\n")
            if line == "◇ Suite DashboardNativeBrowserFailureTests started.":
                suite_start += 1
            if re.fullmatch(r"[✔✘] Suite DashboardNativeBrowserFailureTests (passed|failed) after [0-9.]+ seconds(?: with [0-9]+ issues?)?\.", line):
                suite_end += 1
            for i, name in enumerate(NAMES):
                if line == '◇ Test "' + name + '" started.':
                    starts[i] += 1
                cases = " with 3 test cases" if i == 2 else ""
                if re.fullmatch('[✔✘] Test "' + re.escape(name) + '"' + cases + r" (passed|failed) after [0-9.]+ seconds(?: with [0-9]+ issues?)?\.", line):
                    ends[i] += 1
            for trigger in TRIGGERS:
                if line == '◇ Test case passing 1 argument trigger → "' + trigger + '" to "' + NAMES[2] + '" started.':
                    args[trigger] += 1
            m = re.fullmatch(r"[✔✘] Test run with ([0-9]+) tests in ([0-9]+) suites? (passed|failed) after [0-9.]+ seconds(?: with [0-9]+ issues?)?\.", line)
            if m:
                assert len(terminal) < 1
                terminal.append({"tests": int(m[1]), "suites": int(m[2]), "passed": m[3] == "passed"})
    coverage = starts == [1, 1, 1] and ends == [1, 1, 1] and all(n == 1 for n in args.values()) and suite_start == suite_end == 1
    terminal_selected = len(terminal) == 1 and terminal[0]["tests"] == 3 and terminal[0]["suites"] == 1
    return {"testStarts": starts, "testEnds": ends, "argumentStarts": args,
            "suiteStarts": suite_start, "suiteEnds": suite_end,
            "selectedCoverage": coverage and terminal_selected, "nativeTerminalSummary": terminal}



def collect(root, harness):
    private = Path(os.environ["PRIVATE_PROOF"])
    safe = Path(os.environ["SAFE_PROOF"])
    safe.mkdir(parents=True, exist_ok=True)
    assert private.resolve() != safe.resolve() and private.resolve() not in safe.resolve().parents
    result = {"schema": 1, "qualification": False, "complete": False, "sourceVerified": False,
              "nativeRunEndedValidated": False, "identity": None, "exits": {}, "observations": None,
              "toolchain": None, "failure": "incomplete"}
    try:
        result["identity"] = source(root, harness)
        result["sourceVerified"] = True
        assert load(safe / "identity.json") == result["identity"]
        for phase in PHASES:
            p = private / (phase + ".exit")
            if p.exists():
                value = p.read_text().strip()
                assert re.fullmatch(r"[0-9]{1,3}", value) and int(value) <= 255
                result["exits"][phase] = int(value)
        if (private / "native-raw.log").exists():
            result["observations"] = extract(private / "native-raw.log")
        def version(name, pattern):
            p = private / (name + ".log")
            assert p.stat().st_size <= 16384
            m = re.search(pattern, p.read_text())
            assert m
            return m[1]
        xcode = version("xcode", r"(?m)^Xcode ([0-9]+(?:\.[0-9]+){0,2})$")
        swift = version("swift", r"Apple Swift version ([0-9]+(?:\.[0-9]+){1,2})")
        os_version = version("os", r"^([0-9]+(?:\.[0-9]+){1,2})\s*$")
        node = version("node", r"^v([0-9]+\.[0-9]+\.[0-9]+)\s*$")
        pnpm = version("pnpm", r"^([0-9]+\.[0-9]+\.[0-9]+)\s*$")
        assert (private / "developer.log").read_text().strip() == "/Applications/Xcode.app/Contents/Developer"
        assert int(xcode.split('.')[0]) == 27 and tuple(map(int, swift.split('.')[:2])) >= (6, 3)
        assert tuple(map(int, os_version.split('.')[:2])) >= (26, 2)
        assert node == "24.22.1" and pnpm == "12.15.0"
        width = int((private / "width").read_text())
        assert 1 <= width <= 12
        result["toolchain"] = {"xcode": xcode, "swift": swift, "macOS": os_version, "node": node, "pnpm": pnpm, "width": width}
        # The unchanged launcher validates event-stream runEnded only on exit zero.
        result["nativeRunEndedValidated"] = result["exits"].get("native") == 0
        result["complete"] = (result["exits"] == dict.fromkeys(PHASES, 0)
                              and result["observations"]["selectedCoverage"]
                              and result["observations"]["nativeTerminalSummary"][0]["passed"]
                              and os.environ.get("NATIVE_STEP_OUTCOME") == "success")
        result["failure"] = None if result["complete"] else "incomplete"
    except Exception:
        # No exceptions, paths, assertion values, or raw log text cross the safe boundary.
        result["failure"] = "evidence-invalid-or-incomplete"
    save(safe / "result.json", result)
    print(json.dumps({"complete": result["complete"], "qualification": False}))
    return 0 if result["complete"] else 1


def receipt(directory, expected_path):
    # expected JSON is parent-owned: authenticated run/attempt/workflow/job/artifact tuple.
    expected = load(expected_path)
    assert set(expected) == {"identity", "jobConclusion", "artifactId", "jobId"}
    assert all(re.fullmatch("[1-9][0-9]*", str(expected[k])) for k in ("artifactId", "jobId"))
    assert expected["jobConclusion"] in ("success", "failure", "cancelled", "timed_out")
    assert {p.name for p in directory.iterdir()} == {"identity.json", "result.json"}
    identity = load(directory / "identity.json")
    result = load(directory / "result.json")
    assert identity == expected["identity"] == result["identity"]
    assert set(identity) == {"base", "candidate", "tree", "workflow", "run", "attempt", "manifestSha256", "scope"}
    assert all(re.fullmatch("[0-9a-f]{40}", identity[k]) for k in ("candidate", "tree", "workflow"))
    assert identity["candidate"] != BASE
    assert all(re.fullmatch("[1-9][0-9]*", identity[k]) for k in ("run", "attempt"))
    assert identity["base"] == BASE and identity["scope"] == "selected-native-tests"
    assert identity["manifestSha256"] == digest((HERE / "manifest.json").read_bytes())
    assert result["schema"] == 1 and result["qualification"] is False
    assert all(type(result[k]) is bool for k in ("complete", "sourceVerified", "nativeRunEndedValidated"))
    observations = result["observations"]
    if observations is not None:
        assert set(observations) == {"testStarts", "testEnds", "argumentStarts", "suiteStarts", "suiteEnds", "selectedCoverage", "nativeTerminalSummary"}
        assert type(observations["selectedCoverage"]) is bool
        for field in ("testStarts", "testEnds"):
            assert len(observations[field]) == 3
            assert all(type(n) is int and n >= 0 for n in observations[field])
        assert set(observations["argumentStarts"]) == set(TRIGGERS)
        assert all(type(n) is int and n >= 0 for n in observations["argumentStarts"].values())
        assert all(type(observations[k]) is int and observations[k] >= 0 for k in ("suiteStarts", "suiteEnds"))
    if result["complete"]:
        assert expected["jobConclusion"] == "success" and result["sourceVerified"] and result["nativeRunEndedValidated"]
        assert result["exits"] == dict.fromkeys(PHASES, 0)
        assert observations["selectedCoverage"] is True
        assert observations["nativeTerminalSummary"] == [{"tests": 3, "suites": 1, "passed": True}]
        assert observations["testStarts"] == observations["testEnds"] == [1, 1, 1]
        assert observations["argumentStarts"] == dict.fromkeys(TRIGGERS, 1)
        assert observations["suiteStarts"] == observations["suiteEnds"] == 1
        assert result["failure"] is None and result["toolchain"] is not None
    print(json.dumps({"receiptValid": True, "complete": result["complete"], "qualification": False}))
    return 0 if result["complete"] else 1


def main():
    mode = sys.argv[1]
    if mode == "receipt":
        return receipt(Path(sys.argv[2]), Path(sys.argv[3]))
    if mode in ("bind", "source", "collect"):
        root, harness = map(Path, sys.argv[2:4])
        if mode == "collect":
            return collect(root, harness)
        assert os.environ.get("CI") == "true" and os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_OS") == "macOS"
        assert all(re.fullmatch("[1-9][0-9]*", os.environ[k]) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
        identity = source(root, harness, mode == "bind")
        if mode == "bind":
            save(Path(os.environ["SAFE_PROOF"]) / "identity.json", identity)
        return 0
    raise ValueError("unsupported mode")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Selected-test source/data verification failed.", file=sys.stderr)
        sys.exit(1)
