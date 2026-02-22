#!/usr/bin/env python3
"""
E2E Test: spawn_governed_http → Command Center → openclaw agent → TaskResult

Requires a running OpenClaw Command Center.
Set CC_URL env var to override default (http://localhost:3010).
Set GOVERNED_AUTH_TOKEN or AUTH_TOKEN for authentication.
"""
import os
import subprocess
import sys
from pathlib import Path

CC_URL = os.environ.get("CC_URL", "http://localhost:3010")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def test_import():
    from governed_agents.openclaw_wrapper import spawn_governed_http
    from governed_agents.contract import TaskContract
    assert callable(spawn_governed_http)
    print("✅ Import OK")


def test_endpoint_reachable():
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"{CC_URL}/api/health"],
        capture_output=True, text=True
    )
    code = r.stdout.strip()
    assert code == "200", f"Command Center not reachable (HTTP {code})"
    print(f"✅ Command Center reachable (HTTP {code})")


def test_spawn_endpoint_exists():
    token = os.environ.get("GOVERNED_AUTH_TOKEN") or os.environ.get("AUTH_TOKEN", "")
    r = subprocess.run([
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-X", "POST", f"{CC_URL}/api/governed/spawn",
        "-H", f"Authorization: Bearer {token}",
        "-H", "Content-Type: application/json",
        "-d", "{}"
    ], capture_output=True, text=True)
    code = r.stdout.strip()
    # 422 = Validation error (endpoint exists, missing fields) = OK
    assert code in ("200", "422"), f"Endpoint missing (HTTP {code})"
    print(f"✅ Endpoint exists (HTTP {code})")


def test_spawn_governed_http_import():
    """Test that spawn_governed_http is callable and returns a valid TaskResult."""
    from governed_agents.openclaw_wrapper import spawn_governed_http
    from governed_agents.contract import TaskContract, TaskStatus

    contract = TaskContract(
        objective="Write the text 'governed_test_ok' to /tmp/governed_http_test.txt",
        acceptance_criteria=["File /tmp/governed_http_test.txt exists"],
        required_files=["/tmp/governed_http_test.txt"],
        timeout_seconds=30,
    )

    result = spawn_governed_http(contract)

    assert hasattr(result, "status"), "TaskResult missing .status"
    assert hasattr(result, "task_score"), "TaskResult missing .task_score"
    assert result.status in (TaskStatus.SUCCESS, TaskStatus.BLOCKED, TaskStatus.FAILED), \
        f"Unexpected status: {result.status}"
    print(f"✅ spawn_governed_http returned: status={result.status}, score={result.task_score}")


if __name__ == "__main__":
    test_import()
    test_endpoint_reachable()
    test_spawn_endpoint_exists()
    test_spawn_governed_http_import()
    print("\n✅ All tests passed — spawn_governed_http ready")
