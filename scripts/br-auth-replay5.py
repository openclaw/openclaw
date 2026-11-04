"""One never-landed, fixed-source auth envelope replay on a disposable hosted runner."""

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


SOURCE = "dcf81e57e3d172b2530153dbefb15252edbcd613"
REF = "refs/heads/roboclaw/br-auth-replay5"
ENVELOPE_SHA256 = "161b3856132d2e5fe53d5629dd8937f6905e79a1b563824745a1445ba0e99859"
HERE = Path(__file__).resolve().parent
PROOF = HERE / "evidence"
MAX_LOG_BYTES = 32 * 1024 * 1024
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
POLICY = {
    "CHECKOUT_BASE_SHA": "8b9e240149fb8c3c871f92a653a0423fcc8b320d",
    "NODE_OPTIONS": "--max-old-space-size=8192",
    "OPENCLAW_CI_TEST_RUNTIME_POLICY": "bun-all",
    "FROZEN_TARGET": "false",
    "RUNNER_ENVIRONMENT": "github-hosted",
    "OPENCLAW_VITEST_MAX_WORKERS": "3",
    "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS": "300000",
    "OPENCLAW_NODE_TEST_PLAN_CONCURRENCY": "1",
    "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON": "[]",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(name, value):
    PROOF.mkdir(mode=0o700, parents=True, exist_ok=True)
    (PROOF / name).write_text(json.dumps(value, indent=2) + "\n")


def fixed_contract():
    raw = (HERE / "br-auth-replay5-envelope.json").read_bytes()
    assert digest(raw) == ENVELOPE_SHA256, "Frozen envelope digest mismatch"
    envelope = json.loads(raw)
    assert len(envelope) == 1 and len(envelope[0]["configs"]) == 2
    assert len(envelope[0]["includePatterns"]) == 15
    manifest = json.loads((HERE / "br-auth-replay5-source.json").read_text())
    assert manifest["source"] == SOURCE
    assert manifest["envelope_sha256"] == ENVELOPE_SHA256
    assert manifest["policy"] == POLICY
    assert manifest["files"] == envelope[0]["includePatterns"]
    return envelope, manifest


def hosted_source():
    assert os.environ.get("GITHUB_ACTIONS") == "true", "Hosted execution only"
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    assert os.environ.get("GITHUB_REPOSITORY") == "openclaw/openclaw"
    assert os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
    assert os.environ.get("GITHUB_REF") == REF
    assert os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "No replay attempts"
    assert os.environ.get("GITHUB_ACTOR") == "roboclaw-bot"
    assert os.environ.get("RUNNER_OS") == "Linux"
    assert os.environ.get("RUNNER_ARCH") == "X64"
    assert re.fullmatch(r"[a-f0-9]{40}", os.environ["GITHUB_SHA"])
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    assert actual == SOURCE, "Source checkout mismatch"
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--"], check=True)
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN",
                "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"):
        assert not os.environ.get(key), "Unexpected credential environment name: " + key


def resources():
    return json.loads(subprocess.check_output([
        "node", "-e", 'const o=require("node:os");console.log(JSON.stringify({'
        'cpus:o.availableParallelism(),memoryBytes:o.totalmem(),node:process.version,'
        'platform:process.platform,arch:process.arch}))'
    ], text=True))


def admit():
    hosted_source()
    envelope, manifest = fixed_contract()
    # Public fixed metadata read; no job token or secret reaches source/test code.
    connection = http.client.HTTPSConnection("api.github.com", timeout=30)
    connection.request("GET", "/repos/openclaw/openclaw/pulls/192635", headers={
        "Accept": "application/vnd.github+json", "User-Agent": "br-auth-replay5",
        "Cache-Control": "no-cache",
    })
    response = connection.getresponse()
    assert response.status == 200, "Public PR admission HTTP status " + str(response.status)
    raw = response.read(262145)
    assert len(raw) <= 262144, "PR admission response exceeds bound"
    pr = json.loads(raw)
    connection.close()
    assert pr["number"] == 192635 and pr["state"] == "open" and pr["draft"]
    assert pr["user"]["login"] == "roboclaw-bot"
    assert pr["head"]["repo"]["full_name"] == "openclaw/openclaw"
    assert pr["head"]["ref"] == "roboclaw/br-hook-revocation-diagnostics"
    assert pr["head"]["sha"] == SOURCE and pr["base"]["ref"] == "main"
    for path, expected in manifest["source_sha256"].items():
        assert digest(Path(path).read_bytes()) == expected, "Source file mismatch: " + path
    machine = resources()
    write("authority.json", {
        "source": SOURCE, "workflow_sha": os.environ["GITHUB_SHA"],
        "workflow_ref": os.environ.get("GITHUB_WORKFLOW_REF"),
        "run_id": os.environ["GITHUB_RUN_ID"], "run_attempt": 1,
        "actor": "roboclaw-bot", "pr": 192635, "pr_head": pr["head"]["sha"],
        "envelope_sha256": ENVELOPE_SHA256, "envelope": envelope,
        "runner_environment": os.environ["RUNNER_ENVIRONMENT"],
        "runner_name": os.environ.get("RUNNER_NAME"), "resources_before_setup": machine,
        "runner_image": {"os": os.environ.get("ImageOS"),
                         "version": os.environ.get("ImageVersion")},
        "job_tokens_forwarded": False,
    })
    assert os.environ.get("ImageOS") and os.environ.get("ImageVersion"), "Hosted image identity missing"
    assert machine["cpus"] == 4, "Original runner CPU class mismatch"
    assert 14 * 1024 ** 3 <= machine["memoryBytes"] <= 18 * 1024 ** 3, "Original runner RAM class mismatch"


def process_identities():
    result = []
    # Disposable runner only. No argv, environment, file contents or user databases.
    names = [name for name in os.listdir("/proc") if name.isdecimal()]
    assert len(names) <= 4096, "Process observation exceeds bound"
    for name in names:
        try:
            directory = Path("/proc") / name
            if directory.stat().st_uid != os.geteuid():
                continue
            raw = (directory / "stat").read_text()
            fields = raw[raw.rfind(")") + 2:].split()
            result.append({"pid": int(name), "parent_pid": int(fields[1]),
                           "group": int(fields[2]), "start_ticks": fields[19],
                           "state": fields[0]})
        except (FileNotFoundError, ProcessLookupError):
            continue
    return result


def run():
    hosted_source()
    envelope, manifest = fixed_contract()
    assert (PROOF / "authority.json").is_file(), "Admission receipt missing"
    for key, value in POLICY.items():
        assert os.environ.get(key) == value, "Runtime policy mismatch: " + key
    assert not os.environ.get("OPENCLAW_E2E_USE_PREBUILT_DIST")
    assert not os.environ.get("OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64")
    env = dict(os.environ)
    env["OPENCLAW_NODE_TEST_GROUPS_JSON"] = json.dumps(envelope, separators=(",", ":"))
    argv = ["node", "--import", "tsx", "scripts/ci-run-node-test-shard.mts"]
    before = process_identities()
    write("launch.json", {"source": SOURCE, "argv": argv, "policy": POLICY,
                          "envelope": envelope, "resources": resources(),
                          "bun_version": subprocess.check_output(["bun", "--version"], text=True).strip(),
                          "bun_revision": subprocess.check_output(["bun", "--revision"], text=True).strip(),
                          "source_sha256": manifest["source_sha256"], "before_processes": before})
    started = time.time()
    child = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    total = 0
    assert child.stdout is not None
    with (PROOF / "execution.log").open("wb") as log:
        while chunk := child.stdout.read1(65536):
            log.write(chunk[:max(0, MAX_LOG_BYTES - total)])
            total += len(chunk)
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    code = child.wait()
    after = process_identities()
    original = {(p["pid"], p["start_ticks"]) for p in before}
    remaining = [p for p in after if (p["pid"], p["start_ticks"]) not in original]
    write("process-result.json", {"code": code, "child_pid": child.pid,
                                 "elapsed_seconds": time.time() - started,
                                 "log_bytes_produced": total, "log_complete": total <= MAX_LOG_BYTES,
                                 "after_processes": after, "new_processes_after": remaining,
                                 "forced_cleanup": False})
    return code if code >= 0 else 128 - code


def finalize():
    fixed_contract()
    log = PROOF / "execution.log"
    text = ANSI.sub("", log.read_text(errors="replace")) if log.exists() else ""
    observations = []
    lines = [line for line in text.splitlines() if "[shard-failure:" not in line]
    for line in lines:
        marker = "[cli-auth:revocation-observation] "
        if marker in line:
            try:
                item = json.loads(line.split(marker, 1)[1].strip())
            except json.JSONDecodeError:
                continue
            assert set(item) == {"status", "beforeRevocation", "launchesAfterRevocation",
                                 "requestsBeforeRevocation", "requestsAfterRevocation", "events"}
            observations.append(item)
    completions = [json.loads(line.split("[shard:completion] ", 1)[1])
                   for line in lines if "[shard:completion] " in line]
    configs = [line for line in lines if "[test] starting test/vitest/" in line]
    summaries = [line for line in lines if re.search(r"\b(Test Files|Tests)\s+", line)]
    file_counts = [int(match.group(1)) for line in lines
                   if (match := re.search(r"\bTest Files\s+.*\((\d+)\)", line))]
    test_counts = [int(match.group(1)) for line in lines
                   if (match := re.search(r"\bTests\s+.*\((\d+)\)", line))]
    result_file = PROOF / "process-result.json"
    result = json.loads(result_file.read_text()) if result_file.exists() else {}
    trace_rows = []
    invocation_groups = {}
    trace_valid = False
    try:
        assert len(observations) == 1
        observation = observations[0]
        events = observation["events"]
        assert events["limitReached"] is False and len(events["events"]) < 65536
        trace_rows = [json.loads(line) for line in events["events"].splitlines()]
        assert trace_rows
        for event in trace_rows:
            assert set(event) == {"pid", "parentPid", "invocationId", "event", "fixturePid",
                                  "scenario", "nativeRootMatchesFixture", "flags",
                                  "oauthDescriptorPresent", "apiKeyDescriptorPresent"}
            assert event["event"] in {"launch", "initialize", "user", "other"}
            assert event["scenario"] == "hook-accounts" and event["nativeRootMatchesFixture"] is True
            assert re.fullmatch(r"[a-f0-9-]{36}", event["invocationId"])
            assert all(type(event[k]) is int and event[k] > 0 for k in ["pid", "parentPid", "fixturePid"])
            assert set(event["flags"]) <= {"-p", "--print", "--input-format", "--session-id",
                                           "--resume", "--tools", "--settings", "--mcp-config"}
            assert all(type(event[k]) is bool for k in ["oauthDescriptorPresent", "apiKeyDescriptorPresent"])
            invocation_groups.setdefault(event["invocationId"], []).append(event)
        assert len({event["fixturePid"] for event in trace_rows}) == 1
        assert type(observation["launchesAfterRevocation"]) is int
        assert len(invocation_groups) == observation["launchesAfterRevocation"]
        assert len({rows[0]["pid"] for rows in invocation_groups.values()}) == len(invocation_groups)
        for rows in invocation_groups.values():
            assert rows[0]["event"] == "launch"
            assert sum(row["event"] == "launch" for row in rows) == 1
            identity = {key: value for key, value in rows[0].items() if key != "event"}
            assert all({key: value for key, value in row.items() if key != "event"} == identity
                       for row in rows)
        trace_valid = True
    except (AssertionError, KeyError, TypeError, ValueError):
        pass
    checks = {"process_exit_zero": result.get("code") == 0,
              "log_complete": result.get("log_complete") is True,
              "canonical_disposal_receipt": any(c == {"version": 1, "planned": 1,
                  "completed": 1, "invocations": 1, "failedInvocations": 0} for c in completions),
              "both_configs_started_in_order": len(configs) == 2 and
                  "vitest.gateway-server-isolated.config.ts" in configs[0] and
                  "vitest.gateway-database-workers.config.ts" in configs[1],
              "original_partition_totals": file_counts == [7, 8] and test_counts == [25, 77],
              "revocation_observation_present": len(observations) == 1,
              "revocation_refusal_and_counts_preserved": len(observations) == 1 and
                  observations[0]["status"] == 502 and
                  observations[0]["beforeRevocation"] == observations[0]["launchesAfterRevocation"] and
                  observations[0]["requestsBeforeRevocation"] == observations[0]["requestsAfterRevocation"],
              "complete_owned_allowlisted_trace": trace_valid,
              "no_new_runner_user_processes": result.get("new_processes_after") == []}
    write("observations.json", {"revocation": observations, "completions": completions,
                                "trace_rows": trace_rows, "configs": configs,
                                "invocation_groups": invocation_groups,
                                "file_counts": file_counts, "test_counts": test_counts,
                                "test_summaries": summaries})
    write("outcome.json", {"status": "PASS_COUNTEREXAMPLE_ONLY" if all(checks.values()) else
                           "FAIL" if result.get("code", 0) != 0 else "INCOMPLETE",
                           "checks": checks, "causal_fix": False,
                           "original_ninth_attributed": False,
                           "original_run": 41784433080, "original_job": 126423705925,
                           "source": SOURCE})
    files = [p for p in PROOF.iterdir() if p.is_file() and p.name != "manifest.json"]
    write("manifest.json", {p.name: {"bytes": p.stat().st_size, "sha256": digest(p.read_bytes())}
                            for p in files})
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    assert len(sys.argv) == 2 and sys.argv[1] in {"admit", "run", "finalize", "validate"}
    mode = sys.argv[1]
    if mode == "validate":
        fixed_contract()
    elif mode == "admit":
        admit()
    elif mode == "run":
        sys.exit(run())
    else:
        sys.exit(finalize())
